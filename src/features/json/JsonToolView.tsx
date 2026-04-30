import { useState } from "react";
import SubViewHeader from "../../components/SubViewHeader";

type JsonToolViewProps = {
  onBack: () => void;
};

function JsonToolView({ onBack }: JsonToolViewProps) {
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState("");

  const formatJson = () => {
    if (!jsonInput.trim()) {
      setJsonError("");
      return;
    }

    try {
      const parsed = JSON.parse(jsonInput);
      setJsonInput(JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setJsonError(`无效的 JSON 文本: ${message}`);
    }
  };

  const escapeJson = () => {
    if (!jsonInput) return;
    setJsonInput(JSON.stringify(jsonInput).slice(1, -1));
    setJsonError("");
  };

  const unescapeJson = () => {
    if (!jsonInput) return;

    try {
      const parsed = JSON.parse(`"${jsonInput}"`);
      setJsonInput(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
      setJsonError("");
    } catch {
      const unescaped = jsonInput
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
      setJsonInput(unescaped);
      setJsonError("");
    }
  };

  return (
    <div className="sub-view">
      <SubViewHeader title="JSON 工具" onBack={onBack} />
      <div className="sub-view-content json-formatter">
        <textarea
          className="json-input single-textarea"
          placeholder="在此粘贴被处理的 JSON 文本..."
          value={jsonInput}
          onChange={(event) => setJsonInput(event.target.value)}
        />
        <div className="json-btn-group">
          <button className="format-btn" onClick={formatJson}>
            格式化
          </button>
          <button className="action-btn" onClick={escapeJson}>
            转义
          </button>
          <button className="action-btn" onClick={unescapeJson}>
            去转义
          </button>
        </div>
        {jsonError && <div className="json-error">{jsonError}</div>}
      </div>
    </div>
  );
}

export default JsonToolView;
