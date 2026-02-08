// Ad-hoc codesign the .app after electron-builder packs it.
// This runs before the distributable (zip/dmg) is created,
// so the signed app ends up inside the final archive.
const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`Ad-hoc signing: ${appPath}`);
  execSync(`codesign --force --deep -s - "${appPath}"`, { stdio: "inherit" });
};
