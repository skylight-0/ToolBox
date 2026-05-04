import type { ToolItem } from "../types/sidebar";
import clipboardIcon from "../assets/clipboard.svg";
import codecIcon from "../assets/codec.svg";
import jsonIcon from "../assets/json.svg";
import networkIcon from "../assets/network.svg";
import qrcodeIcon from "../assets/qrcode.svg";
import quickIcon from "../assets/quick.svg";
import systemInfoIcon from "../assets/systeminfo.svg";
import todoIcon from "../assets/todo.svg";
import tomatoIcon from "../assets/tomato.svg";
import textIcon from "../assets/txt.svg";
import settingIcon from "../assets/setting.svg";

export const TOOLS: ToolItem[] = [
  { id: "json", kind: "view", view: "json", icon: "✨", iconSrc: jsonIcon, label: "JSON 格式化", desc: "粘贴文本格式化" },
  { id: "codec", kind: "view", view: "codec", icon: "🔁", iconSrc: codecIcon, label: "编码转换", desc: "Base64 与 URL 转换" },
  { id: "qrcode", kind: "view", view: "qrcode", icon: "▦", iconSrc: qrcodeIcon, label: "二维码生成器", desc: "文本链接生成二维码" },
  { id: "systeminfo", kind: "view", view: "systeminfo", icon: "▥", iconSrc: systemInfoIcon, label: "本机信息", desc: "CPU 内存磁盘网络" },
  { id: "network", kind: "view", view: "network", icon: "◌", iconSrc: networkIcon, label: "网络小工具", desc: "DNS Ping 端口检测" },
  { id: "todo", kind: "view", view: "todo", icon: "☑️", iconSrc: todoIcon, label: "待办事项", desc: "本地待办清单" },
  { id: "password", kind: "view", view: "password", icon: "🔐", label: "密码管理", desc: "Windows 用户密码保护的账号密码库" },
  { id: "textmanager", kind: "view", view: "textmanager", icon: "🗂️", iconSrc: textIcon, label: "文本管理", desc: "保存文本并按分组整理" },
  { id: "clipboard", kind: "view", view: "clipboard", icon: "📋", iconSrc: clipboardIcon, label: "剪切板增强", desc: "复制历史与图片预览" },
  { id: "quicklaunch", kind: "view", view: "quicklaunch", icon: "📌", iconSrc: quickIcon, label: "快捷访问", desc: "常用程序启动" },
  { id: "portabledesktop", kind: "view", view: "portabledesktop", icon: "🖥️", label: "便携桌面", desc: "桌面式文件与程序分组" },
  { id: "pomodoro", kind: "view", view: "pomodoro", icon: "🍅", iconSrc: tomatoIcon, label: "番茄钟", desc: "专注与休息计时" },
  { id: "settings", kind: "view", view: "settings", icon: "⚙️", iconSrc: settingIcon,label: "设置", desc: "启动、剪切板与侧边栏" },
];
