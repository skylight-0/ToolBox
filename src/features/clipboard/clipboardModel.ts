export type ClipboardGroup = "general" | "snippet";

export type ClipboardItem = {
  id: string;
  type: "text" | "image";
  content: string;
  timestamp: number;
  favorite?: boolean;
  pinned?: boolean;
  tags?: string[];
  group?: ClipboardGroup;
};

export const CLIPBOARD_STORAGE_KEY = "toolbox_clipboard_history";

export type ClipboardRecordInput = {
  id: string;
  type: "text" | "image";
  content: string;
  timestamp: number;
  favorite?: boolean;
  pinned?: boolean;
  tags?: string[];
  group?: ClipboardGroup;
};

function normalizeTags(tags: string[] | undefined) {
  if (!Array.isArray(tags)) return [];
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => tag.toLowerCase()),
    ),
  );
}

export function normalizeClipboardItem(item: ClipboardItem): ClipboardItem {
  return {
    ...item,
    favorite: Boolean(item.favorite),
    pinned: Boolean(item.pinned),
    tags: normalizeTags(item.tags),
    group: item.group === "snippet" ? "snippet" : "general",
  };
}

export function normalizeClipboardItems(items: ClipboardItem[]) {
  return items.map(normalizeClipboardItem);
}

export function getClipboardSearchFields(item: ClipboardItem) {
  const fields = [item.content];
  if (item.group === "snippet") {
    fields.push("代码片段", "snippet", "code");
  }
  if (item.favorite) {
    fields.push("收藏");
  }
  if (item.pinned) {
    fields.push("置顶");
  }
  if (item.tags?.length) {
    fields.push(item.tags.join(" "));
  }
  return fields;
}
