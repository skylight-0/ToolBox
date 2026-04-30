import { useEffect, useMemo, useState } from "react";
import * as QRCode from "qrcode";
import SubViewHeader from "../../components/SubViewHeader";

type QrCodeViewProps = {
  onBack: () => void;
};

type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";

const ERROR_CORRECTION_LEVELS: Array<{
  id: ErrorCorrectionLevel;
  label: string;
  detail: string;
}> = [
  { id: "L", label: "L", detail: "低" },
  { id: "M", label: "M", detail: "标准" },
  { id: "Q", label: "Q", detail: "较高" },
  { id: "H", label: "H", detail: "最高" },
];

const SIZE_PRESETS = [192, 256, 384, 512];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withAlpha(hexColor: string) {
  if (/^#[0-9a-fA-F]{6}$/.test(hexColor)) {
    return `${hexColor}ff`;
  }

  return hexColor;
}

function dataUrlToBytes(dataUrl: string) {
  const base64Data = dataUrl.split(",")[1] || "";
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return bytes;
}

function QrCodeView({ onBack }: QrCodeViewProps) {
  const [content, setContent] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [size, setSize] = useState(256);
  const [margin, setMargin] = useState(3);
  const [errorCorrectionLevel, setErrorCorrectionLevel] =
    useState<ErrorCorrectionLevel>("M");
  const [darkColor, setDarkColor] = useState("#111827");
  const [lightColor, setLightColor] = useState("#ffffff");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const contentByteLength = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const selectedCorrectionLevel = ERROR_CORRECTION_LEVELS.find(
    (level) => level.id === errorCorrectionLevel,
  );

  useEffect(() => {
    let isCurrent = true;
    const value = content.trim() ? content : "";

    if (!value) {
      setQrDataUrl("");
      setError("");
      return () => {
        isCurrent = false;
      };
    }

    QRCode.toDataURL(value, {
      type: "image/png",
      width: size,
      margin,
      errorCorrectionLevel,
      color: {
        dark: withAlpha(darkColor),
        light: withAlpha(lightColor),
      },
    })
      .then((dataUrl) => {
        if (!isCurrent) return;
        setQrDataUrl(dataUrl);
        setError("");
      })
      .catch((generationError) => {
        if (!isCurrent) return;
        setQrDataUrl("");
        setError(`生成失败：${getErrorMessage(generationError)}`);
      });

    return () => {
      isCurrent = false;
    };
  }, [content, darkColor, errorCorrectionLevel, lightColor, margin, size]);

  const readClipboardText = async () => {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      const text = (await readText()) || "";
      setContent(text);
      setMessage(text ? "已读取剪贴板" : "剪贴板没有文本");
      setError("");
    } catch (clipboardError) {
      setError(`读取失败：${getErrorMessage(clipboardError)}`);
      setMessage("");
    }
  };

  const copyQrImage = async () => {
    if (!qrDataUrl) return;

    try {
      const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeImage(dataUrlToBytes(qrDataUrl));
      setMessage("已复制二维码图片");
      setError("");
    } catch (clipboardError) {
      setError(`复制失败：${getErrorMessage(clipboardError)}`);
      setMessage("");
    }
  };

  const downloadQrImage = () => {
    if (!qrDataUrl) return;

    const link = document.createElement("a");
    link.href = qrDataUrl;
    link.download = `toolbox-qrcode-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setMessage("已下载 PNG");
    setError("");
  };

  const clearContent = () => {
    setContent("");
    setMessage("");
    setError("");
  };

  return (
    <div className="sub-view">
      <SubViewHeader title="二维码生成器" onBack={onBack} />
      <div className="sub-view-content qrcode-tool">
        <div className="qrcode-layout">
          <section className="qrcode-editor">
            <label className="qrcode-field">
              <span className="qrcode-field-label">文本或链接</span>
              <textarea
                className="json-input qrcode-input"
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setMessage("");
                }}
                placeholder="输入链接、文本、Wi-Fi 配置或其他内容"
              />
            </label>

            <div className="qrcode-controls">
              <div className="qrcode-control-row">
                <span className="qrcode-field-label">尺寸</span>
                <div className="qrcode-size-row">
                  {SIZE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      className={`qrcode-chip ${size === preset ? "active" : ""}`}
                      onClick={() => setSize(preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <label className="qrcode-slider-row">
                <span className="qrcode-field-label">边距 {margin}</span>
                <input
                  className="qrcode-range"
                  type="range"
                  min="0"
                  max="8"
                  value={margin}
                  onChange={(event) => setMargin(Number(event.target.value))}
                />
              </label>

              <div className="qrcode-control-row">
                <span className="qrcode-field-label">
                  容错 {selectedCorrectionLevel?.detail || "标准"}
                </span>
                <div className="qrcode-level-row">
                  {ERROR_CORRECTION_LEVELS.map((level) => (
                    <button
                      key={level.id}
                      className={`qrcode-chip ${errorCorrectionLevel === level.id ? "active" : ""}`}
                      onClick={() => setErrorCorrectionLevel(level.id)}
                      title={`${level.detail}容错`}
                    >
                      {level.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="qrcode-color-row">
                <label className="qrcode-color-field">
                  <span className="qrcode-field-label">前景</span>
                  <input
                    type="color"
                    value={darkColor}
                    onChange={(event) => setDarkColor(event.target.value)}
                  />
                </label>
                <label className="qrcode-color-field">
                  <span className="qrcode-field-label">背景</span>
                  <input
                    type="color"
                    value={lightColor}
                    onChange={(event) => setLightColor(event.target.value)}
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="qrcode-preview-panel">
            <div className="qrcode-preview-box">
              {qrDataUrl ? (
                <img className="qrcode-preview-image" src={qrDataUrl} alt="二维码预览" />
              ) : (
                <div className="qrcode-preview-empty">输入内容后生成</div>
              )}
            </div>
            <div className="qrcode-meta-row">
              <span>{contentByteLength} 字节</span>
              <span>{size} px</span>
              <span>容错 {errorCorrectionLevel}</span>
            </div>
          </section>
        </div>

        <div className="qrcode-actions">
          <button className="action-btn" onClick={readClipboardText}>
            读剪贴板
          </button>
          <button className="format-btn" onClick={copyQrImage} disabled={!qrDataUrl}>
            复制图片
          </button>
          <button className="action-btn" onClick={downloadQrImage} disabled={!qrDataUrl}>
            下载 PNG
          </button>
          <button className="action-btn" onClick={clearContent} disabled={!content}>
            清空
          </button>
        </div>

        {(message || error) && (
          <div className={`qrcode-message ${error ? "error" : "success"}`}>
            {error || message}
          </div>
        )}
      </div>
    </div>
  );
}

export default QrCodeView;
