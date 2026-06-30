import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useState } from "react";

type TestResult = {
  pressedAt: number;
  shownAt: number;
  delay: number;
};

export default function TestWindow() {
  const testWindow = getCurrentWebviewWindow();
  const [result, setResult] = useState<TestResult | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<number>("test-show", (event) => {
        if (cancelled) return;
        const pressedAt = event.payload;
        const shownAt = Date.now();
        const delay = shownAt - pressedAt;
        console.log(
          `[test] 窗口显示 按下=${pressedAt} 显示=${shownAt} 延迟=${delay}ms`,
        );
        setResult({ pressedAt, shownAt, delay });
        setCount((c) => c + 1);
      });
    })().catch((error) => console.error("监听 test-show 失败", error));
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    void testWindow.hide().catch(() => {});
  };

  return (
    <div className="test-window">
      <h2>快捷键延迟测试</h2>
      <p>按 Ctrl+Shift+T 唤出此窗口</p>
      {result ? (
        <div className="test-result">
          <p>按下时间: <code>{result.pressedAt}</code></p>
          <p>显示时间: <code>{result.shownAt}</code></p>
          <p className="test-delay">延迟: <strong>{result.delay}ms</strong></p>
          <p>已测试次数: {count}</p>
        </div>
      ) : (
        <p>等待测试...</p>
      )}
      <button onClick={close}>关闭</button>
    </div>
  );
}
