import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, MutableRefObject, MouseEvent, ReactNode } from "react";
import { notifyToolboxDataChanged } from "../../utils/dataSync";

type PortableDesktopViewProps = {
  onBack: () => void;
  isDialogOpenRef: MutableRefObject<boolean>;
};

type PortableDesktopItemType = "file" | "folder" | "app" | "script" | "url" | "group";
type ShortcutItemType = "app" | "script" | "url";

type PortableDesktopItem = {
  id: string;
  name: string;
  itemType: PortableDesktopItemType;
  path: string;
  icon?: string;
  args?: string;
  pageIndex?: number;
  sortOrder?: number;
  groupId?: string;
  launchCount?: number;
  lastOpenedAt?: number;
  createdAt?: number;
  updatedAt?: number;
};

type PortableDesktopData = {
  rootPath: string;
  items: PortableDesktopItem[];
};

type PortablePathResult = {
  name: string;
  path: string;
};

type CreateDraft = {
  itemType: "file" | "folder" | "group";
  name: string;
};

type ShortcutDraft = {
  name: string;
  path: string;
  itemType: ShortcutItemType;
  args: string;
};

type RenameDraft = {
  itemId: string;
  name: string;
};

const ITEMS_PER_PAGE = 20;

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeItems(items: PortableDesktopItem[]) {
  return items.map((item, index) => ({
    ...item,
    icon: item.icon || undefined,
    args: item.args || "",
    pageIndex: item.pageIndex ?? 0,
    sortOrder: item.sortOrder ?? index,
    groupId: item.groupId || undefined,
    launchCount: item.launchCount || 0,
    lastOpenedAt: item.lastOpenedAt || 0,
    createdAt: item.createdAt || Date.now(),
    updatedAt: item.updatedAt || Date.now(),
  }));
}

function getDefaultIcon(itemType: PortableDesktopItemType) {
  if (itemType === "folder") return "📁";
  if (itemType === "app") return "▣";
  if (itemType === "script") return "▤";
  if (itemType === "url") return "⌁";
  if (itemType === "group") return "▦";
  return "📄";
}

function getItemMeta(item: PortableDesktopItem) {
  if (item.itemType === "group") return "分组";
  if (item.itemType === "folder") return "文件夹";
  if (item.itemType === "app") return "程序";
  if (item.itemType === "script") return "脚本";
  if (item.itemType === "url") return "网址";
  return "文件";
}

function getLaunchItemType(item: PortableDesktopItem) {
  if (item.itemType === "folder") return "folder";
  if (item.itemType === "url") return "url";
  if (item.itemType === "script") return "script";
  return "app";
}

function getBaseName(path: string) {
  const baseName = path.split(/[\\/]/).pop() || path;
  return baseName.replace(/\.[^.]+$/, "");
}

function createNotification(level: string, title: string, message: string) {
  return {
    id: `portable-desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    level,
    title,
    message,
    source: "portable-desktop",
    createdAt: Date.now(),
    read: false,
  };
}

function isPhysicalItem(item: PortableDesktopItem) {
  return item.itemType === "file" || item.itemType === "folder";
}

function canMoveIntoGroup(item: PortableDesktopItem) {
  return item.itemType === "app" || item.itemType === "script" || item.itemType === "url";
}

function getNextPageSortOrder(items: PortableDesktopItem[], pageIndex: number) {
  return items
    .filter((item) => !item.groupId && (item.pageIndex || 0) === pageIndex)
    .reduce((max, item) => Math.max(max, item.sortOrder || 0), -1) + 1;
}

function getNextGroupSortOrder(items: PortableDesktopItem[], groupId: string) {
  return items
    .filter((item) => item.groupId === groupId)
    .reduce((max, item) => Math.max(max, item.sortOrder || 0), -1) + 1;
}

function reindexPage(items: PortableDesktopItem[], pageIndex: number) {
  const pageItems = items
    .filter((item) => !item.groupId && (item.pageIndex || 0) === pageIndex)
    .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0))
    .map((item, index) => ({ ...item, sortOrder: index }));
  const others = items.filter((item) => item.groupId || (item.pageIndex || 0) !== pageIndex);
  return [...others, ...pageItems];
}

function reindexGroup(items: PortableDesktopItem[], groupId: string) {
  const groupItems = items
    .filter((item) => item.groupId === groupId)
    .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0))
    .map((item, index) => ({ ...item, sortOrder: index }));
  const others = items.filter((item) => item.groupId !== groupId);
  return [...others, ...groupItems];
}

function PortableDesktopView({ onBack, isDialogOpenRef }: PortableDesktopViewProps) {
  const [rootPath, setRootPath] = useState("");
  const [items, setItems] = useState<PortableDesktopItem[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<ShortcutDraft | null>(null);
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const itemsRef = useRef<PortableDesktopItem[]>([]);

  const hasDialog = Boolean(createDraft || shortcutDraft || renameDraft || openGroupId);

  useEffect(() => {
    invoke<PortableDesktopData>("get_portable_desktop_data")
      .then((data) => {
        const normalizedItems = normalizeItems(data.items || []);
        setRootPath(data.rootPath);
        setItems(normalizedItems);
        itemsRef.current = normalizedItems;
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    isDialogOpenRef.current = hasDialog;
    return () => {
      isDialogOpenRef.current = false;
    };
  }, [hasDialog, isDialogOpenRef]);

  const topLevelItems = useMemo(
    () => items.filter((item) => !item.groupId),
    [items],
  );

  const highestPageIndex = topLevelItems.reduce(
    (max, item) => Math.max(max, item.pageIndex || 0),
    0,
  );
  const pageCount = Math.max(1, highestPageIndex + 1, activePage + 1);

  const groupItem = useMemo(
    () => items.find((item) => item.id === openGroupId && item.itemType === "group") || null,
    [items, openGroupId],
  );

  const groupItems = useMemo(
    () =>
      openGroupId
        ? items
            .filter((item) => item.groupId === openGroupId)
            .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0))
        : [],
    [items, openGroupId],
  );

  useEffect(() => {
    if (openGroupId && !groupItem) {
      setOpenGroupId(null);
    }
  }, [groupItem, openGroupId]);

  const visibleItems = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    const baseItems = keyword
      ? topLevelItems
      : topLevelItems.filter((item) => (item.pageIndex || 0) === activePage);

    return baseItems
      .filter((item) => {
        if (!keyword) return true;
        const groupChildren = item.itemType === "group"
          ? items
              .filter((child) => child.groupId === item.id)
              .map((child) => child.name)
              .join(" ")
          : "";
        return `${item.name} ${item.path} ${item.args || ""} ${groupChildren}`
          .toLowerCase()
          .includes(keyword);
      })
      .sort((left, right) => {
        if (keyword) {
          return (left.pageIndex || 0) - (right.pageIndex || 0) || (left.sortOrder || 0) - (right.sortOrder || 0);
        }
        return (left.sortOrder || 0) - (right.sortOrder || 0);
      });
  }, [activePage, items, searchKeyword, topLevelItems]);

  const emitNotification = async (level: string, title: string, message: string) => {
    try {
      await invoke("insert_notification", {
        notification: createNotification(level, title, message),
      });
    } catch (error) {
      console.error(error);
    }
  };

  const persistPortableDesktopData = (
    nextItems: PortableDesktopItem[],
    options?: { silent?: boolean },
  ) => {
    const normalizedItems = normalizeItems(nextItems);
    itemsRef.current = normalizedItems;
    setItems(normalizedItems);
    void invoke("save_portable_desktop_data", {
      data: { rootPath, items: normalizedItems },
    })
      .then(() => notifyToolboxDataChanged("portable-desktop"))
      .catch(async (error) => {
        console.error(error);
        if (!options?.silent) {
          await emitNotification("error", "保存便携桌面失败", String(error));
        }
      });
  };

  const requestIcon = async (item: PortableDesktopItem) => {
    if (!["app", "script"].includes(item.itemType)) return;

    try {
      const icon = await invoke<string>("extract_program_icon", { path: item.path });
      const nextItems = itemsRef.current.map((currentItem) =>
        currentItem.id === item.id ? { ...currentItem, icon, updatedAt: Date.now() } : currentItem,
      );
      persistPortableDesktopData(nextItems, { silent: true });
    } catch {
      // Program icon extraction is optional.
    }
  };

  const buildTopLevelItem = (
    patch: Pick<PortableDesktopItem, "name" | "itemType" | "path"> &
      Partial<Pick<PortableDesktopItem, "args" | "icon">>,
  ): PortableDesktopItem => {
    const now = Date.now();
    return {
      id: createId(),
      name: patch.name.trim(),
      itemType: patch.itemType,
      path: patch.path,
      icon: patch.icon,
      args: patch.args || "",
      pageIndex: activePage,
      sortOrder: getNextPageSortOrder(itemsRef.current, activePage),
      launchCount: 0,
      lastOpenedAt: 0,
      createdAt: now,
      updatedAt: now,
    };
  };

  const openCreateDraft = (itemType: CreateDraft["itemType"]) => {
    setCreateDraft({ itemType, name: "" });
  };

  const saveCreateDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!createDraft || !createDraft.name.trim()) return;

    try {
      let newItem: PortableDesktopItem;

      if (createDraft.itemType === "group") {
        newItem = buildTopLevelItem({
          name: createDraft.name,
          itemType: "group",
          path: "",
        });
      } else if (createDraft.itemType === "folder") {
        const result = await invoke<PortablePathResult>("create_portable_desktop_folder", {
          name: createDraft.name,
        });
        newItem = buildTopLevelItem({
          name: result.name,
          itemType: "folder",
          path: result.path,
        });
      } else {
        const result = await invoke<PortablePathResult>("create_portable_desktop_file", {
          name: createDraft.name,
        });
        newItem = buildTopLevelItem({
          name: result.name,
          itemType: "file",
          path: result.path,
        });
      }

      persistPortableDesktopData([...itemsRef.current, newItem]);
      setCreateDraft(null);
      await emitNotification("success", "已创建桌面项目", newItem.name);
    } catch (error) {
      console.error(error);
      await emitNotification("error", "创建失败", String(error));
    }
  };

  const openShortcutDraft = () => {
    setShortcutDraft({
      name: "",
      path: "",
      itemType: "app",
      args: "",
    });
  };

  const pickShortcutTarget = async () => {
    if (!shortcutDraft || shortcutDraft.itemType === "url") return;

    try {
      const selected = await open({
        multiple: false,
        title: "选择程序或脚本",
        filters:
          shortcutDraft.itemType === "script"
            ? [{ name: "脚本", extensions: ["bat", "cmd", "ps1", "vbs", "js", "*"] }]
            : [{ name: "程序", extensions: ["exe", "lnk", "msc", "*"] }],
      });
      if (!selected || Array.isArray(selected)) return;

      setShortcutDraft((current) =>
        current
          ? {
              ...current,
              path: selected,
              name: current.name || getBaseName(selected),
            }
          : current,
      );
    } catch (error) {
      console.error(error);
    }
  };

  const saveShortcutDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!shortcutDraft) return;

    const targetPath = shortcutDraft.path.trim();
    const name = shortcutDraft.name.trim();
    if (!targetPath || !name) return;

    const newItem = buildTopLevelItem({
      name,
      itemType: shortcutDraft.itemType,
      path: targetPath,
      args: shortcutDraft.args.trim(),
    });
    persistPortableDesktopData([...itemsRef.current, newItem]);
    setShortcutDraft(null);
    await emitNotification("success", "已添加程序", newItem.name);
    void requestIcon(newItem);
  };

  const openRenameDraft = (item: PortableDesktopItem, event: MouseEvent) => {
    event.stopPropagation();
    setRenameDraft({ itemId: item.id, name: item.name });
  };

  const saveRenameDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameDraft || !renameDraft.name.trim()) return;

    const item = itemsRef.current.find((currentItem) => currentItem.id === renameDraft.itemId);
    if (!item) return;

    try {
      let nextName = renameDraft.name.trim();
      let nextPath = item.path;

      if (isPhysicalItem(item)) {
        const result = await invoke<PortablePathResult>("rename_portable_desktop_entry", {
          path: item.path,
          newName: nextName,
        });
        nextName = result.name;
        nextPath = result.path;
      }

      persistPortableDesktopData(
        itemsRef.current.map((currentItem) =>
          currentItem.id === item.id
            ? {
                ...currentItem,
                name: nextName,
                path: nextPath,
                updatedAt: Date.now(),
              }
            : currentItem,
        ),
      );
      setRenameDraft(null);
      await emitNotification("success", "已重命名", nextName);
    } catch (error) {
      console.error(error);
      await emitNotification("error", "重命名失败", String(error));
    }
  };

  const deleteItem = async (item: PortableDesktopItem, event?: MouseEvent) => {
    event?.stopPropagation();
    const confirmed = window.confirm(`删除「${item.name}」？`);
    if (!confirmed) return;

    try {
      let nextItems = itemsRef.current;

      if (item.itemType === "group") {
        const groupPageIndex = item.pageIndex || 0;
        const withoutGroup = nextItems.filter((currentItem) => currentItem.id !== item.id);
        let nextSortOrder = getNextPageSortOrder(withoutGroup, groupPageIndex);
        nextItems = withoutGroup.map((currentItem) =>
          currentItem.groupId === item.id
            ? {
                ...currentItem,
                groupId: undefined,
                pageIndex: groupPageIndex,
                sortOrder: nextSortOrder++,
                updatedAt: Date.now(),
              }
            : currentItem,
        );
        nextItems = reindexPage(nextItems, groupPageIndex);
        if (openGroupId === item.id) {
          setOpenGroupId(null);
        }
      } else {
        if (isPhysicalItem(item)) {
          await invoke("delete_portable_desktop_entry", { path: item.path });
        }
        nextItems = nextItems.filter((currentItem) => currentItem.id !== item.id);
        nextItems = item.groupId
          ? reindexGroup(nextItems, item.groupId)
          : reindexPage(nextItems, item.pageIndex || 0);
      }

      persistPortableDesktopData(nextItems);
      await emitNotification("info", "已删除桌面项目", item.name);
    } catch (error) {
      console.error(error);
      await emitNotification("error", "删除失败", String(error));
    }
  };

  const openDesktopItem = async (item: PortableDesktopItem) => {
    if (item.itemType === "group") {
      setOpenGroupId(item.id);
      return;
    }
    if (!item.path.trim()) return;

    persistPortableDesktopData(
      itemsRef.current.map((currentItem) =>
        currentItem.id === item.id
          ? {
              ...currentItem,
              launchCount: (currentItem.launchCount || 0) + 1,
              lastOpenedAt: Date.now(),
              updatedAt: Date.now(),
            }
          : currentItem,
      ),
      { silent: true },
    );

    try {
      await invoke("launch_program", {
        request: {
          target: item.path,
          itemType: getLaunchItemType(item),
          args: item.args || "",
        },
      });
    } catch (error) {
      console.error(error);
      await emitNotification("error", "打开失败", `${item.name}: ${String(error)}`);
    }
  };

  const reorderWithinContext = (targetItemId: string) => {
    if (!draggingItemId || draggingItemId === targetItemId) {
      setDraggingItemId(null);
      return;
    }

    const draggedItem = itemsRef.current.find((item) => item.id === draggingItemId);
    const targetItem = itemsRef.current.find((item) => item.id === targetItemId);
    if (!draggedItem || !targetItem) {
      setDraggingItemId(null);
      return;
    }

    const sameGroup = draggedItem.groupId && draggedItem.groupId === targetItem.groupId;
    const samePage =
      !draggedItem.groupId &&
      !targetItem.groupId &&
      (draggedItem.pageIndex || 0) === (targetItem.pageIndex || 0);
    if (!sameGroup && !samePage) {
      setDraggingItemId(null);
      return;
    }

    const contextItems = itemsRef.current
      .filter((item) =>
        draggedItem.groupId
          ? item.groupId === draggedItem.groupId
          : !item.groupId && (item.pageIndex || 0) === (draggedItem.pageIndex || 0),
      )
      .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0));
    const fromIndex = contextItems.findIndex((item) => item.id === draggingItemId);
    const toIndex = contextItems.findIndex((item) => item.id === targetItemId);
    if (fromIndex < 0 || toIndex < 0) {
      setDraggingItemId(null);
      return;
    }

    const [movedItem] = contextItems.splice(fromIndex, 1);
    contextItems.splice(toIndex, 0, movedItem);
    const otherItems = itemsRef.current.filter(
      (item) => !contextItems.some((contextItem) => contextItem.id === item.id),
    );
    persistPortableDesktopData(
      [...otherItems, ...contextItems.map((item, index) => ({ ...item, sortOrder: index }))],
      { silent: true },
    );
    setDraggingItemId(null);
  };

  const moveItemToGroup = (groupId: string) => {
    if (!draggingItemId) return;

    const draggedItem = itemsRef.current.find((item) => item.id === draggingItemId);
    const targetGroup = itemsRef.current.find((item) => item.id === groupId && item.itemType === "group");
    if (!draggedItem || !targetGroup || !canMoveIntoGroup(draggedItem)) {
      setDraggingItemId(null);
      return;
    }

    const sourceGroupId = draggedItem.groupId;
    const sourcePageIndex = draggedItem.pageIndex || 0;
    const movedItems = itemsRef.current.map((item) =>
      item.id === draggingItemId
        ? {
            ...item,
            groupId,
            pageIndex: targetGroup.pageIndex || 0,
            sortOrder: getNextGroupSortOrder(itemsRef.current, groupId),
            updatedAt: Date.now(),
          }
        : item,
    );
    const reindexed = sourceGroupId
      ? reindexGroup(movedItems, sourceGroupId)
      : reindexPage(movedItems, sourcePageIndex);
    persistPortableDesktopData(reindexGroup(reindexed, groupId), { silent: true });
    setDraggingItemId(null);
  };

  const moveItemToPage = (pageIndex: number) => {
    if (!draggingItemId) return;

    const draggedItem = itemsRef.current.find((item) => item.id === draggingItemId);
    if (!draggedItem) {
      setDraggingItemId(null);
      return;
    }

    const sourceGroupId = draggedItem.groupId;
    const sourcePageIndex = draggedItem.pageIndex || 0;
    const movedItems = itemsRef.current.map((item) =>
      item.id === draggingItemId
        ? {
            ...item,
            groupId: undefined,
            pageIndex,
            sortOrder: getNextPageSortOrder(itemsRef.current, pageIndex),
            updatedAt: Date.now(),
          }
        : item,
    );
    const sourceReindexed = sourceGroupId
      ? reindexGroup(movedItems, sourceGroupId)
      : reindexPage(movedItems, sourcePageIndex);
    persistPortableDesktopData(reindexPage(sourceReindexed, pageIndex), { silent: true });
    setActivePage(pageIndex);
    setDraggingItemId(null);
  };

  const removeItemFromGroup = (item: PortableDesktopItem, event: MouseEvent) => {
    event.stopPropagation();
    if (!item.groupId) return;

    const groupId = item.groupId;
    const movedItems = itemsRef.current.map((currentItem) =>
      currentItem.id === item.id
        ? {
            ...currentItem,
            groupId: undefined,
            pageIndex: activePage,
            sortOrder: getNextPageSortOrder(itemsRef.current, activePage),
            updatedAt: Date.now(),
          }
        : currentItem,
    );
    persistPortableDesktopData(reindexPage(reindexGroup(movedItems, groupId), activePage), {
      silent: true,
    });
  };

  const handleItemDrop = (targetItem: PortableDesktopItem, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const draggedItem = itemsRef.current.find((item) => item.id === draggingItemId);
    if (targetItem.itemType === "group" && draggedItem && canMoveIntoGroup(draggedItem)) {
      moveItemToGroup(targetItem.id);
      return;
    }

    reorderWithinContext(targetItem.id);
  };

  const handleSurfaceDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (searchKeyword.trim()) {
      setDraggingItemId(null);
      return;
    }
    moveItemToPage(activePage);
  };

  const handleGroupDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (openGroupId) {
      moveItemToGroup(openGroupId);
    }
  };

  const renderIcon = (item: PortableDesktopItem): ReactNode => {
    if (item.itemType === "group") {
      const previewItems = items
        .filter((child) => child.groupId === item.id)
        .sort((left, right) => (left.sortOrder || 0) - (right.sortOrder || 0))
        .slice(0, 4);

      return (
        <div className="portable-group-preview">
          {previewItems.length > 0 ? (
            previewItems.map((child) => (
              <span key={child.id} className="portable-group-preview-cell">
                {child.icon ? (
                  <img src={child.icon} alt="" draggable={false} />
                ) : (
                  <span>{getDefaultIcon(child.itemType)}</span>
                )}
              </span>
            ))
          ) : (
            <span className="portable-empty-group-icon">▦</span>
          )}
        </div>
      );
    }

    if (item.icon) {
      return <img src={item.icon} alt="" draggable={false} />;
    }

    return <span className="portable-default-icon">{getDefaultIcon(item.itemType)}</span>;
  };

  const renderDesktopItem = (item: PortableDesktopItem, compact = false) => (
    <div
      key={item.id}
      data-portable-item
      className={`portable-desktop-item ${compact ? "compact" : ""} ${draggingItemId === item.id ? "dragging" : ""}`}
      title={item.path || item.name}
      draggable={!searchKeyword.trim()}
      onDragStart={() => setDraggingItemId(item.id)}
      onDragEnd={() => setDraggingItemId(null)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => handleItemDrop(item, event)}
      onDoubleClick={() => void openDesktopItem(item)}
    >
      <button
        className="portable-item-action rename"
        title="重命名"
        onClick={(event) => openRenameDraft(item, event)}
      >
        ✎
      </button>
      <button
        className="portable-item-action delete"
        title="删除"
        onClick={(event) => void deleteItem(item, event)}
      >
        ×
      </button>
      {item.groupId && (
        <button
          className="portable-item-action ungroup"
          title="移出分组"
          onClick={(event) => removeItemFromGroup(item, event)}
        >
          ↗
        </button>
      )}
      <div className="portable-item-icon">{renderIcon(item)}</div>
      <div className="portable-item-name" title={item.name}>
        {item.name}
      </div>
      <div className="portable-item-meta">{getItemMeta(item)}</div>
    </div>
  );

  return (
    <div className="sub-view portable-desktop-view">
      <div className="portable-desktop-header">
        <div className="portable-desktop-heading">
          <div className="back-btn" onClick={onBack}>
            <span className="back-icon">←</span> 返回
          </div>
          <div>
            <h2 className="sub-view-title active-group-title">便携桌面</h2>
            <div className="portable-desktop-root" title={rootPath}>
              {rootPath || "portable-desktop"}
            </div>
          </div>
        </div>

        <div className="portable-desktop-actions">
          <button className="portable-action-btn" onClick={() => openCreateDraft("file")}>
            + 文件
          </button>
          <button className="portable-action-btn" onClick={() => openCreateDraft("folder")}>
            + 文件夹
          </button>
          <button className="portable-action-btn" onClick={openShortcutDraft}>
            + 程序
          </button>
          <button className="portable-action-btn primary" onClick={() => openCreateDraft("group")}>
            + 分组
          </button>
        </div>
      </div>

      <div className="portable-desktop-toolbar">
        <input
          className="quicklaunch-search-input portable-search-input"
          placeholder="搜索桌面项目..."
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
        />
        <div className="portable-page-indicator">
          {activePage + 1} / {pageCount}
        </div>
      </div>

      <div
        className="portable-desktop-surface"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleSurfaceDrop}
      >
        {visibleItems.length > 0 ? (
          <div className="portable-desktop-grid">
            {visibleItems.slice(0, searchKeyword.trim() ? undefined : ITEMS_PER_PAGE).map((item) =>
              renderDesktopItem(item),
            )}
          </div>
        ) : (
          <div className="portable-desktop-empty">暂无桌面项目</div>
        )}
      </div>

      <div className="portable-desktop-pagination">
        <button
          className="portable-page-btn"
          disabled={activePage === 0}
          onClick={() => setActivePage(Math.max(0, activePage - 1))}
        >
          ‹
        </button>
        {Array.from({ length: pageCount }, (_, index) => (
          <button
            key={index}
            className={`portable-page-chip ${activePage === index ? "active" : ""}`}
            onClick={() => setActivePage(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              moveItemToPage(index);
            }}
          >
            {index + 1}
          </button>
        ))}
        <button
          className="portable-page-chip add"
          onClick={() => setActivePage(pageCount)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            moveItemToPage(pageCount);
          }}
        >
          +
        </button>
        <button
          className="portable-page-btn"
          disabled={activePage >= pageCount - 1}
          onClick={() => setActivePage(Math.min(pageCount - 1, activePage + 1))}
        >
          ›
        </button>
      </div>

      {createDraft && (
        <div className="quicklaunch-dialog-overlay" onClick={() => setCreateDraft(null)}>
          <form className="quicklaunch-dialog portable-dialog" onSubmit={saveCreateDraft} onClick={(event) => event.stopPropagation()}>
            <h3 className="settings-title">
              {createDraft.itemType === "file"
                ? "新建文件"
                : createDraft.itemType === "folder"
                  ? "新建文件夹"
                  : "新建分组"}
            </h3>
            <div className="settings-row">
              <label className="settings-label">名称</label>
              <input
                autoFocus
                className="settings-input"
                value={createDraft.name}
                placeholder={createDraft.itemType === "file" ? "note.txt" : "名称"}
                onChange={(event) =>
                  setCreateDraft((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="settings-actions">
              <button type="button" className="settings-cancel-btn" onClick={() => setCreateDraft(null)}>
                取消
              </button>
              <button type="submit" className="settings-save-btn">
                创建
              </button>
            </div>
          </form>
        </div>
      )}

      {shortcutDraft && (
        <div className="quicklaunch-dialog-overlay" onClick={() => setShortcutDraft(null)}>
          <form className="quicklaunch-dialog portable-dialog" onSubmit={saveShortcutDraft} onClick={(event) => event.stopPropagation()}>
            <h3 className="settings-title">添加程序</h3>
            <div className="settings-row">
              <label className="settings-label">类型</label>
              <select
                className="settings-input"
                value={shortcutDraft.itemType}
                onChange={(event) =>
                  setShortcutDraft((current) =>
                    current
                      ? {
                          ...current,
                          itemType: event.target.value as ShortcutItemType,
                          path: event.target.value === "url" ? current.path : "",
                        }
                      : current,
                  )
                }
              >
                <option value="app">程序</option>
                <option value="script">脚本</option>
                <option value="url">网址</option>
              </select>
            </div>
            <div className="settings-row">
              <label className="settings-label">显示名称</label>
              <input
                className="settings-input"
                value={shortcutDraft.name}
                onChange={(event) =>
                  setShortcutDraft((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="settings-row">
              <label className="settings-label">目标路径 / 地址</label>
              <div className="quicklaunch-target-row">
                <input
                  className="settings-input"
                  value={shortcutDraft.path}
                  placeholder={shortcutDraft.itemType === "url" ? "https://example.com" : "请选择目标"}
                  onChange={(event) =>
                    setShortcutDraft((current) =>
                      current ? { ...current, path: event.target.value } : current,
                    )
                  }
                />
                {shortcutDraft.itemType !== "url" && (
                  <button type="button" className="settings-cancel-btn quicklaunch-pick-btn" onClick={pickShortcutTarget}>
                    选择
                  </button>
                )}
              </div>
            </div>
            {shortcutDraft.itemType !== "url" && (
              <div className="settings-row">
                <label className="settings-label">启动参数</label>
                <input
                  className="settings-input"
                  value={shortcutDraft.args}
                  placeholder="可选"
                  onChange={(event) =>
                    setShortcutDraft((current) =>
                      current ? { ...current, args: event.target.value } : current,
                    )
                  }
                />
              </div>
            )}
            <div className="settings-actions">
              <button type="button" className="settings-cancel-btn" onClick={() => setShortcutDraft(null)}>
                取消
              </button>
              <button type="submit" className="settings-save-btn">
                添加
              </button>
            </div>
          </form>
        </div>
      )}

      {renameDraft && (
        <div className="quicklaunch-dialog-overlay" onClick={() => setRenameDraft(null)}>
          <form className="quicklaunch-dialog portable-dialog" onSubmit={saveRenameDraft} onClick={(event) => event.stopPropagation()}>
            <h3 className="settings-title">重命名</h3>
            <div className="settings-row">
              <label className="settings-label">名称</label>
              <input
                autoFocus
                className="settings-input"
                value={renameDraft.name}
                onChange={(event) =>
                  setRenameDraft((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="settings-actions">
              <button type="button" className="settings-cancel-btn" onClick={() => setRenameDraft(null)}>
                取消
              </button>
              <button type="submit" className="settings-save-btn">
                保存
              </button>
            </div>
          </form>
        </div>
      )}

      {groupItem && (
        <div className="quicklaunch-dialog-overlay" onClick={() => setOpenGroupId(null)}>
          <div className="portable-group-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="portable-group-header">
              <div>
                <h3 className="settings-title">{groupItem.name}</h3>
                <div className="portable-group-count">{groupItems.length} 个项目</div>
              </div>
              <button className="portable-group-close" onClick={() => setOpenGroupId(null)}>
                ×
              </button>
            </div>
            <div
              className="portable-group-grid"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleGroupDrop}
            >
              {groupItems.length > 0 ? (
                groupItems.map((item) => renderDesktopItem(item, true))
              ) : (
                <div className="portable-desktop-empty small">暂无项目</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PortableDesktopView;
