export type ActiveView =
  | "main"
  | "json"
  | "todo"
  | "clipboard"
  | "quicklaunch"
  | "pomodoro";

export type ToolItem = {
  id: Exclude<ActiveView, "main"> | "notepad" | "calc" | "terminal" | "settings";
  icon: string;
  label: string;
  desc: string;
};

export type ToggleSwitchItem = {
  id: "desktop" | "taskbar";
  icon: string;
  label: string;
  active: boolean;
};
