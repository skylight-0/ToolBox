export type ActiveView =
  | "main"
  | "json"
  | "todo"
  | "clipboard"
  | "quicklaunch"
  | "textmanager"
  | "pomodoro";

export type ViewToolId = Exclude<ActiveView, "main">;
export type ToolId = ViewToolId;

type ToolBase = {
  id: ToolId;
  icon: string;
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
  label: string;
  desc?: string;
  active: boolean;
  pending?: boolean;
};
