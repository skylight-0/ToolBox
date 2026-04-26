import { useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type CodecToolViewProps = {
  onBack: () => void;
};

type CodecOperationId =
  | "base64-encode"
  | "base64-decode"
  | "url-encode"
  | "url-decode";

type CodecOperation = {
  id: CodecOperationId;
  label: string;
};

const CODEC_OPERATIONS: CodecOperation[] = [
  { id: "base64-encode", label: "Base64 编码" },
  { id: "base64-decode", label: "Base64 解码" },
  { id: "url-encode", label: "URL 编码" },
  { id: "url-decode", label: "URL 解码" },
];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
}

function decodeBase64(value: string) {
  const normalized = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  if (!normalized) return "";

  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const binary = atob(`${normalized}${"=".repeat(paddingLength)}`);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function transformText(operationId: CodecOperationId, value: string) {
  switch (operationId) {
    case "base64-encode":
      return encodeBase64(value);
    case "base64-decode":
      return decodeBase64(value);
    case "url-encode":
      return encodeURIComponent(value);
    case "url-decode":
      return decodeURIComponent(value);
    default:
      return value;
  }
}

function CodecToolView({ onBack }: CodecToolViewProps) {
  const [operationId, setOperationId] = useState<CodecOperationId>("base64-encode");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const currentOperation =
    CODEC_OPERATIONS.find((operation) => operation.id === operationId) ?? CODEC_OPERATIONS[0];

  const convertInput = () => {
    if (!input) {
      setOutput("");
      setMessage("");
      setError("");
      return;
    }

    try {
      setOutput(transformText(operationId, input));
      setMessage(`${currentOperation.label}完成`);
      setError("");
    } catch (conversionError) {
      setError(`转换失败：${getErrorMessage(conversionError)}`);
      setMessage("");
    }
  };

  const readClipboardText = async () => {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      const text = (await readText()) || "";
      setInput(text);
      setMessage(text ? "已读取剪贴板" : "剪贴板没有文本");
      setError("");
    } catch (clipboardError) {
      setError(`读取失败：${getErrorMessage(clipboardError)}`);
      setMessage("");
    }
  };

  const copyOutput = async () => {
    if (!output) return;

    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(output);
      setMessage("已复制结果");
      setError("");
    } catch (clipboardError) {
      setError(`复制失败：${getErrorMessage(clipboardError)}`);
      setMessage("");
    }
  };

  const swapContent = () => {
    if (!output) return;

    setInput(output);
    setOutput(input);
    setMessage("已交换输入输出");
    setError("");
  };

  const clearContent = () => {
    setInput("");
    setOutput("");
    setMessage("");
    setError("");
  };

  return (
    <div className="sub-view">
      <SubViewHeader title="编码转换" onBack={onBack} />
      <div className="sub-view-content codec-tool">
        <div className="codec-mode-row">
          {CODEC_OPERATIONS.map((operation) => (
            <button
              key={operation.id}
              className={`codec-mode-btn ${operationId === operation.id ? "active" : ""}`}
              onClick={() => {
                setOperationId(operation.id);
                setMessage("");
                setError("");
              }}
            >
              {operation.label}
            </button>
          ))}
        </div>

        <div className="codec-panels">
          <label className="codec-panel">
            <span className="codec-panel-title">输入</span>
            <textarea
              className="json-input codec-textarea"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="输入文本"
            />
          </label>
          <label className="codec-panel">
            <span className="codec-panel-title">输出</span>
            <textarea
              className="json-input codec-textarea codec-output"
              value={output}
              readOnly
              placeholder="转换结果"
            />
          </label>
        </div>

        <div className="codec-actions">
          <button className="format-btn" onClick={convertInput}>
            转换
          </button>
          <button className="action-btn" onClick={readClipboardText}>
            读剪贴板
          </button>
          <button className="action-btn" onClick={copyOutput} disabled={!output}>
            复制结果
          </button>
          <button className="action-btn" onClick={swapContent} disabled={!output}>
            交换
          </button>
          <button className="action-btn" onClick={clearContent} disabled={!input && !output}>
            清空
          </button>
        </div>

        {(message || error) && (
          <div className={`codec-message ${error ? "error" : "success"}`}>
            {error || message}
          </div>
        )}
      </div>
    </div>
  );
}

export default CodecToolView;
