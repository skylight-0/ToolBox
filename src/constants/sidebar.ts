import type { ToolItem } from "../types/sidebar";

export const TOOLS: ToolItem[] = [
  { id: "json", kind: "view", view: "json", icon: "✨", label: "JSON 格式化", desc: "粘贴文本格式化" },
  { id: "todo", kind: "view", view: "todo", icon: "☑️", label: "待办事项", desc: "本地待办清单" },
  { id: "textmanager", kind: "view", view: "textmanager", icon: "🗂️", label: "文本管理", desc: "保存文本并按分组整理" },
  { id: "screenshot", kind: "capture", view: "screenshot", icon: "📸", label: "截图标注", desc: "截图后标注、复制、保存和钉图" },
  { id: "clipboard", kind: "view", view: "clipboard", icon: "📋", label: "剪切板增强", desc: "复制历史与图片预览" },
  { id: "notepad", kind: "action", action: "notepad", icon: "📝", label: "记事本", desc: "快速新建文本" },
  { id: "calc", kind: "action", action: "calc", icon: "🧮", label: "计算器", desc: "打开计算器" },
  { id: "terminal", kind: "action", action: "terminal", icon: "🖥️", label: "终端", desc: "命令行面板" },
  { id: "quicklaunch", kind: "view", view: "quicklaunch", icon: "📌", label: "快捷访问", desc: "常用程序启动" },
  { id: "pomodoro", kind: "view", view: "pomodoro", icon: "🍅", label: "番茄钟", desc: "专注与休息计时" },
  { id: "settings", kind: "action", action: "settings", icon: "⚙️", label: "系统设置", desc: "Windows 设置" },
];
