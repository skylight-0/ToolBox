export type ActiveView =
  | "main"
  | "json"
  | "todo"
  | "clipboard"
  | "quicklaunch"
  | "textmanager"
  | "screenshot"
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
    })
  | (ToolBase & {
      kind: "capture";
      view: "screenshot";
    });

export type ToggleSwitchItem = {
  id: "desktop" | "taskbar";
  icon: string;
  label: string;
  active: boolean;
  pending?: boolean;
};
