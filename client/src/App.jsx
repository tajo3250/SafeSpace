import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Login from "./pages/login";
import Signup from "./pages/signup";
import Chat from "./pages/chat";
import Forgot from "./pages/forgot";
import Reset from "./pages/reset";
import Settings from "./pages/settings";
import Download from "./pages/download";
import { SettingsProvider } from "./context/settings.jsx";
import DesktopBanner from "./components/DesktopBanner.jsx";

function App() {
  return (
    <SettingsProvider>
      <div className="relative min-h-[100dvh]">
        <div className="ss-app-bg" aria-hidden="true" />
        <div className="relative z-10 min-h-[100dvh]">
          <DesktopBanner />
          <Router>
            <Routes>
              <Route path="/" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              <Route path="/forgot" element={<Forgot />} />
              <Route path="/reset" element={<Reset />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/download" element={<Download />} />
            </Routes>
          </Router>
        </div>
      </div>
    </SettingsProvider>
  );
}

export default App;
