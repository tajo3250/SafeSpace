// client/src/hooks/useE2EEManager.js
// Custom hook for managing E2EE operations (encryption, decryption, key management)

import { useState, useRef, useCallback, useEffect } from "react";
import * as E2EE from "../utils/e2ee";
import { API_BASE } from "../config";
import { getToken } from "../utils/authStorage";

export function useE2EEManager(currentUser) {
    const [myKeyPair, setMyKeyPair] = useState(null);
    const [decryptedMessages, setDecryptedMessages] = useState({});
    const [groupKeyMap, setGroupKeyMap] = useState({}); // convId -> { [version]: { cryptoKey, version, keyString } }

    const publicKeyCacheRef = useRef({});
    const decryptQueueRef = useRef({});
    const keyHistoryBackfillRef = useRef({});
    const keyHistoryPatchInFlightRef = useRef({});

    // Load user keypair on mount
    useEffect(() => {
        if (!currentUser?.id) return;

        (async () => {
            try {
                const result = await E2EE.loadOrCreateKeyPairForUser(currentUser.id);
                const { keyPair, kid, ring } = result || {};
                if (!keyPair) throw new Error("Missing E2EE keypair");
                setMyKeyPair(keyPair);

                // Upload public key to server if needed
                const token = getToken();
                const pubJwk =
                    ring?.keys?.[kid]?.publicJwk ||
                    (await window.crypto.subtle.exportKey("jwk", keyPair.publicKey));

                await fetch(`${API_BASE}/api/users/keys`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ publicKey: pubJwk }),
                });
            } catch (e) {
                console.error("Failed to initialize E2EE keypair", e);
            }
        })();
    }, [currentUser?.id]);

    const getUserPublicKeyJwk = useCallback(async (userId) => {
        if (publicKeyCacheRef.current[userId]) {
            return publicKeyCacheRef.current[userId];
        }

        try {
            const token = getToken();
            const resp = await fetch(`${API_BASE}/api/users/${userId}/public-key`, {
                headers: { Authorization: `Bearer ${token}` },
            });

            if (!resp.ok) return null;
            const data = await resp.json();
            const jwk = data?.publicKey;
            if (jwk) publicKeyCacheRef.current[userId] = jwk;
            return jwk || null;
        } catch {
            return null;
        }
    }, []);

    const ensureGroupKey = useCallback(async (conversation, desiredVersion) => {
        if (!conversation || conversation.type !== "group") return null;
        if (!currentUser || !myKeyPair) return null;

        const convId = conversation.id;
        const version = desiredVersion ?? conversation.keyVersion ?? 1;

        // Check cache first
        const cached = groupKeyMap[convId]?.[version];
        if (cached?.cryptoKey) return cached.cryptoKey;

        // Check localStorage
        const lsMap = E2EE.loadGroupKeyStringMap(currentUser.id, convId);
        if (lsMap[String(version)]) {
            try {
                const keyString = lsMap[String(version)];
                const cryptoKey = await E2EE.importAesKeyFromGroupKeyString(keyString);

                setGroupKeyMap((prev) => ({
                    ...prev,
                    [convId]: {
                        ...prev[convId],
                        [version]: { cryptoKey, version, keyString },
                    },
                }));

                return cryptoKey;
            } catch (e) {
                console.error("Failed to import group key from localStorage", e);
            }
        }

        // Check conversation object in memory (e.g. from socket update)
        let encryptedKeyFromObj = null;
        if (conversation.encryptedKeys && typeof conversation.encryptedKeys === "object") {
            // For current version
            if (version === conversation.keyVersion) {
                encryptedKeyFromObj = conversation.encryptedKeys[currentUser.id];
            }
        }
        if (!encryptedKeyFromObj && conversation.encryptedKeysByVersion && typeof conversation.encryptedKeysByVersion === "object") {
            // For specific version
            if (conversation.encryptedKeysByVersion[version] && typeof conversation.encryptedKeysByVersion[version] === "object") {
                encryptedKeyFromObj = conversation.encryptedKeysByVersion[version][currentUser.id];
            }
        }

        if (encryptedKeyFromObj) {
            try {
                // Decrypt the group key - handle both formats:
                // New format: { ciphertext, iv, senderPublicKey } (embedded JWK)
                // Legacy format: { ciphertext, iv, from } (userId to look up)
                const parsed = typeof encryptedKeyFromObj === "string"
                    ? JSON.parse(encryptedKeyFromObj)
                    : encryptedKeyFromObj;

                const unwrapWithJwk = async (jwk) => {
                    const otherPublicKey = await window.crypto.subtle.importKey(
                        "jwk",
                        jwk,
                        { name: "ECDH", namedCurve: "P-256" },
                        true,
                        []
                    );
                    const sharedKey = await window.crypto.subtle.deriveKey(
                        { name: "ECDH", public: otherPublicKey },
                        myKeyPair.privateKey,
                        { name: "AES-GCM", length: 256 },
                        false,
                        ["decrypt"]
                    );
                    return E2EE.decryptWithAesGcm(parsed, sharedKey);
                };

                let groupKeyString = null;

                // Try embedded senderPublicKey first (reliable across key rotations)
                if (parsed.senderPublicKey) {
                    try {
                        groupKeyString = await unwrapWithJwk(parsed.senderPublicKey);
                    } catch {
                        // embedded key failed, try fallback
                    }
                }

                // Fallback: fetch current public key by userId
                if (!groupKeyString && parsed.from) {
                    try {
                        const fromJwk = await getUserPublicKeyJwk(parsed.from);
                        if (fromJwk) {
                            groupKeyString = await unwrapWithJwk(fromJwk);
                        }
                    } catch {
                        // server key fetch/decrypt failed
                    }
                }

                if (groupKeyString) {
                    const cryptoKey = await E2EE.importAesKeyFromGroupKeyString(groupKeyString);

                    // Cache it
                    E2EE.persistGroupKeyString(currentUser.id, convId, version, groupKeyString);
                    setGroupKeyMap((prev) => ({
                        ...prev,
                        [convId]: {
                            ...prev[convId],
                            [version]: { cryptoKey, version, keyString: groupKeyString },
                        },
                    }));

                    return cryptoKey;
                }
            } catch (e) {
                console.error("Failed to decrypt group key from conversation object", e);
                // Fallthrough to fetch from server
            }
        }

        // Fetch from server
        try {
            const token = getToken();
            const resp = await fetch(
                `${API_BASE}/api/conversations/${convId}/my-group-key?version=${version}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );

            if (!resp.ok) return null;

            const data = await resp.json();
            const encryptedKey = data?.encryptedKey;
            if (!encryptedKey) return null;

            // Decrypt the group key - handle both formats
            const parsed = typeof encryptedKey === "string"
                ? JSON.parse(encryptedKey)
                : encryptedKey;

            const unwrapWithJwk = async (jwk) => {
                const otherPublicKey = await window.crypto.subtle.importKey(
                    "jwk",
                    jwk,
                    { name: "ECDH", namedCurve: "P-256" },
                    true,
                    []
                );
                const sharedKey = await window.crypto.subtle.deriveKey(
                    { name: "ECDH", public: otherPublicKey },
                    myKeyPair.privateKey,
                    { name: "AES-GCM", length: 256 },
                    false,
                    ["decrypt"]
                );
                return E2EE.decryptWithAesGcm(parsed, sharedKey);
            };

            let groupKeyString = null;

            // Try embedded senderPublicKey first
            if (parsed.senderPublicKey) {
                try {
                    groupKeyString = await unwrapWithJwk(parsed.senderPublicKey);
                } catch {
                    // embedded key failed
                }
            }

            // Fallback: fetch by userId
            if (!groupKeyString && parsed.from) {
                try {
                    const fromJwk = await getUserPublicKeyJwk(parsed.from);
                    if (fromJwk) {
                        groupKeyString = await unwrapWithJwk(fromJwk);
                    }
                } catch {
                    // fallback failed
                }
            }

            if (!groupKeyString) return null;

            const cryptoKey = await E2EE.importAesKeyFromGroupKeyString(groupKeyString);

            // Cache it
            E2EE.persistGroupKeyString(currentUser.id, convId, version, groupKeyString);
            setGroupKeyMap((prev) => ({
                ...prev,
                [convId]: {
                    ...prev[convId],
                    [version]: { cryptoKey, version, keyString: groupKeyString },
                },
            }));

            return cryptoKey;
        } catch (e) {
            console.error("Failed to fetch/decrypt group key", e);
            return null;
        }
    }, [currentUser, myKeyPair, groupKeyMap]);

    const buildEncryptedGroupKeysForMembers = useCallback(async (memberIds, groupKeyString) => {
        if (!myKeyPair) return {};

        const myPublicJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
        const encryptedKeys = {};

        for (const uid of memberIds) {
            try {
                const otherJwk = await getUserPublicKeyJwk(uid);
                if (!otherJwk) continue;

                const otherPublicKey = await window.crypto.subtle.importKey(
                    "jwk",
                    otherJwk,
                    { name: "ECDH", namedCurve: "P-256" },
                    true,
                    []
                );

                const sharedKey = await window.crypto.subtle.deriveKey(
                    { name: "ECDH", public: otherPublicKey },
                    myKeyPair.privateKey,
                    { name: "AES-GCM", length: 256 },
                    false,
                    ["encrypt"]
                );

                const { ciphertext, iv } = await E2EE.encryptWithAesGcm(groupKeyString, sharedKey);

                encryptedKeys[uid] = JSON.stringify({
                    ciphertext,
                    iv,
                    senderPublicKey: myPublicJwk,
                    from: currentUser?.id || null,
                });
            } catch (e) {
                console.error(`Failed to encrypt group key for user ${uid}`, e);
            }
        }

        return encryptedKeys;
    }, [myKeyPair, getUserPublicKeyJwk]);

    const encryptForConversation = useCallback(async (plaintext, conversation) => {
        if (!E2EE.isConversationE2EE(conversation)) return plaintext;
        if (!myKeyPair) throw new Error("No keypair available");

        if (conversation.type === "dm") {
            const dmKey = await E2EE.deriveDmKeyForConversation({
                conversation,
                currentUserId: currentUser.id,
                myKeyPair,
                fetchUserPublicKeyJwk: getUserPublicKeyJwk,
            });
            const encrypted = await E2EE.encryptDmMessage(plaintext, dmKey);
            return JSON.stringify(encrypted);
        }

        if (conversation.type === "group") {
            const version = conversation.keyVersion ?? 1;
            const aesKey = await ensureGroupKey(conversation, version);
            if (!aesKey) throw new Error("No group key available");

            const { ciphertext, iv } = await E2EE.encryptWithAesGcm(plaintext, aesKey);
            return JSON.stringify({
                e2ee: true,
                version: 1,
                algo: "AES-GCM",
                keyVersion: version,
                iv,
                ciphertext,
            });
        }

        return plaintext;
    }, [currentUser, myKeyPair, getUserPublicKeyJwk, ensureGroupKey]);

    return {
        myKeyPair,
        decryptedMessages,
        setDecryptedMessages,
        groupKeyMap,
        setGroupKeyMap,
        getUserPublicKeyJwk,
        ensureGroupKey,
        buildEncryptedGroupKeysForMembers,
        encryptForConversation,
        publicKeyCacheRef,
        decryptQueueRef,
        keyHistoryBackfillRef,
        keyHistoryPatchInFlightRef,
    };
}
