import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import PasswordView from "./PasswordView";

const appWindow = getCurrentWebviewWindow();
const PASSWORD_REQUIRE_AUTH_SETTING_KEY = "password_require_auth";

export default function PasswordWindow() {
  const isDialogOpenRef = useRef(false);
  const [requirePasswordAuth, setRequirePasswordAuth] = useState(true);

  useEffect(() => {
    invoke<string | null>("get_setting", { key: PASSWORD_REQUIRE_AUTH_SETTING_KEY })
      .then((value) => {
        if (value === "false") setRequirePasswordAuth(false);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="password-window-standalone">
      <PasswordView
        onBack={() => { appWindow.close().catch(console.error); }}
        isDialogOpenRef={isDialogOpenRef}
        requirePasswordAuth={requirePasswordAuth}
      />
    </div>
  );
}
