import type { ToolItem } from "../types/sidebar";

export const TOOLS: ToolItem[] = [
  { id: "json", icon: "✨", label: "JSON 格式化", desc: "粘贴文本格式化" },
  { id: "todo", icon: "☑️", label: "待办事项", desc: "本地待办清单" },
  { id: "clipboard", icon: "📋", label: "剪切板增强", desc: "复制历史与图片预览" },
  { id: "notepad", icon: "📝", label: "记事本", desc: "快速新建文本" },
  { id: "calc", icon: "🧮", label: "计算器", desc: "打开计算器" },
  { id: "terminal", icon: "🖥️", label: "终端", desc: "命令行面板" },
  { id: "quicklaunch", icon: "📌", label: "快捷访问", desc: "常用程序启动" },
  { id: "pomodoro", icon: "🍅", label: "番茄钟", desc: "专注与休息计时" },
  { id: "settings", icon: "⚙️", label: "系统设置", desc: "Windows 设置" },
];
