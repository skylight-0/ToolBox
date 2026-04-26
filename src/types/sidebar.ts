export type ActiveView =
  | "main"
  | "json"
  | "codec"
  | "qrcode"
  | "systeminfo"
  | "network"
  | "todo"
  | "clipboard"
  | "quicklaunch"
  | "textmanager"
  | "pomodoro"
  | "settings";

export type ViewToolId = Exclude<ActiveView, "main">;
export type ToolId = ViewToolId;

type ToolBase = {
  id: ToolId;
  icon: string;
  iconSrc?: string;
  label: string;
  desc: string;
};

export type ToolItem =
  | (ToolBase & {
      kind: "view";
      view: ViewToolId;
    });

export type ToggleSwitchItem = {
  id: "desktop" | "taskbar";
  icon: string;
  iconSrc?: string;
  label: string;
  desc?: string;
  active: boolean;
  pending?: boolean;
};
