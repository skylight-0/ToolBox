import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useState } from "react";

type PinMenuPayload = {
  sourceLabel: string;
  items: string[];
};

export default function PinMenuWindow() {
  const menuWindow = getCurrentWebviewWindow();
  const [payload, setPayload] = useState<PinMenuPayload | null>(null);

  // 窗口获得焦点时主动拉取待显示的菜单数据，避免 emit 时序问题
  useEffect(() => {
    let unlistenFocus: (() => void) | undefined;
    void (async () => {
      unlistenFocus = await menuWindow.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          void invoke<PinMenuPayload | null>("get_pending_pin_menu")
            .then((data) => {
              if (data) setPayload(data);
            })
            .catch(console.error);
        }
      });
    })().catch((error) => console.error("监听焦点失败", error));
    return () => {
      unlistenFocus?.();
    };
  }, [menuWindow]);

  const handleClick = async (item: string) => {
    if (!payload) return;
    await invoke("pin_menu_action", {
      sourceLabel: payload.sourceLabel,
      action: item,
    }).catch(console.error);
    await menuWindow.hide().catch(() => {});
  };

  return (
    <div className="pin-menu-window">
      {payload?.items.map((item) => (
        <button key={item} onClick={() => void handleClick(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}
