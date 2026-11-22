import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, Dispatch, RefObject, SetStateAction } from "react";
import {
  ApiError,
  createCategory,
  createChannel,
  deleteCategory,
  getChannels,
  moveChannelToCategory,
  renameCategory,
  reorderCategories,
  reorderChannels,
  type Channel,
  type ChannelCategory,
  type CreateChannelInput
} from "../api";
import { reorderChannel, swapCategories } from "../lib/channelOrder";
import { CategoryDialog } from "./CategoryDialog";
import { ChannelCategoryMenu } from "./ChannelCategoryMenu";
import { ChannelMenu } from "./ChannelMenu";
import { ChannelPropertiesModal } from "./ChannelPropertiesModal";
import { ChannelSidebar } from "./ChannelSidebar";
import { CreateChannelModal } from "./CreateChannelModal";
import { MoveToCategoryMenu } from "./MoveToCategoryMenu";
import { requestError } from "./settings/ChannelOverrideEditor";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import type { ReorderDropTarget, ReorderItem } from "./useDragReorder";

interface WorkspaceChannelSidebarProps extends Omit<ComponentProps<typeof ChannelSidebar>,
  "onCreateChannel" | "onCreateCategory" | "onCategoryError" | "onReorderItem" | "dragAnnouncement" |
  "onOpenCategoryMenu" | "openCategoryMenuId" | "onOpenChannelMenu" | "openChannelMenuId"
> {
  csrfToken: string;
  channelsRef: RefObject<Channel[]>;
  replaceChannels: (channels: Channel[]) => void;
  setCategories: Dispatch<SetStateAction<ChannelCategory[]>>;
  preserveUnreadCounts: (channels: Channel[]) => void;
  onSessionExpired: () => void;
  onCategoryError: (message: string | null) => void;
  propertiesTarget: Channel | null;
  onPropertiesTargetChange: (target: Channel | null) => void;
}

type OpenMenu = { kind: "channel" | "category"; id: string };

const orderError = "Не удалось сохранить порядок. Попробуйте ещё раз.";

function placeChannelAtCategoryEnd(
  channels: Channel[],
  categories: ChannelCategory[],
  movedChannel: Channel
): Channel[] {
  const remaining = channels.filter((channel) => channel.id !== movedChannel.id);
  const lastInCategory = remaining.findLastIndex((channel) => channel.categoryId === movedChannel.categoryId);
  let insertionIndex = lastInCategory + 1;

  if (lastInCategory === -1 && movedChannel.categoryId !== null) {
    const categoryIndex = categories.findIndex((category) => category.id === movedChannel.categoryId);
    const followingCategory = categories.slice(categoryIndex + 1).find((category) =>
      remaining.some((channel) => channel.categoryId === category.id)
    );
    insertionIndex = followingCategory
      ? remaining.findIndex((channel) => channel.categoryId === followingCategory.id)
      : remaining.length;
  }

  remaining.splice(insertionIndex, 0, movedChannel);
  return remaining;
}

async function submitCategory(name: string, submit: () => Promise<void>): Promise<void> {
  const length = Array.from(name.trim()).length;
  if (length < 1 || length > 80) throw new Error("Название категории должно содержать от 1 до 80 символов.");
  try {
    await submit();
  } catch (error) {
    throw new Error(requestError(error));
  }
}

export function WorkspaceChannelSidebar({
  csrfToken,
  channelsRef,
  replaceChannels,
  setCategories,
  preserveUnreadCounts,
  onSessionExpired,
  onCategoryError,
  propertiesTarget,
  onPropertiesTargetChange,
  ...sidebar
}: WorkspaceChannelSidebarProps) {
  const { categories, channels, canManageChannels } = sidebar;
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const [createTarget, setCreateTarget] = useState<ChannelCategory | null | undefined>(undefined);
  const [moveTarget, setMoveTarget] = useState<Channel | null>(null);
  const [renameTarget, setRenameTarget] = useState<ChannelCategory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChannelCategory | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isReorderingCategories, setIsReorderingCategories] = useState(false);
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const categoryTrigger = useRef<HTMLButtonElement | null>(null);
  const channelTrigger = useRef<HTMLButtonElement | null>(null);
  const orderSaveInFlight = useRef(false);
  const active = useRef(true);

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const expireSession = useCallback(() => {
    if (active.current) onSessionExpired();
  }, [onSessionExpired]);

  const categoryMenuId = openMenu?.kind === "category" ? openMenu.id : null;
  const channelMenuId = openMenu?.kind === "channel" && !propertiesTarget ? openMenu.id : null;
  const categoryIndex = categories.findIndex((category) => category.id === categoryMenuId);
  const categoryForMenu = categories[categoryIndex];
  const channelForMenu = channels.find((channel) => channel.id === channelMenuId);

  function openActionMenu(kind: OpenMenu["kind"], id: string, trigger: HTMLButtonElement): void {
    const entries = kind === "category" ? categories : channels;
    if (!canManageChannels || !entries.some((entry) => entry.id === id)) return;
    const triggerRef = kind === "category" ? categoryTrigger : channelTrigger;
    triggerRef.current = trigger;
    setOpenMenu((current) => current?.kind === kind && current.id === id ? null : { kind, id });
  }

  function openCreateChannel(categoryId: string | null): void {
    if (!canManageChannels) return;
    const target = categoryId === null ? null : categories.find((category) => category.id === categoryId);
    if (target !== undefined) setCreateTarget(target);
  }

  async function refreshChannelList(preserveUnread: boolean): Promise<void> {
    const data = await getChannels();
    if (!active.current) return;
    replaceChannels(data.channels);
    setCategories(data.categories);
    if (preserveUnread) preserveUnreadCounts(data.channels);
  }

  function refreshAfterEdit(preserveUnread: boolean): void {
    void refreshChannelList(preserveUnread).catch((error: unknown) => {
      if (!active.current) return;
      if (error instanceof ApiError && error.status === 401) expireSession();
      else if (preserveUnread) onCategoryError("Не удалось обновить данные канала. Обновите страницу и попробуйте снова.");
    });
  }

  async function saveOrder(save: () => Promise<unknown>, rollback: () => void, announcement?: string): Promise<void> {
    orderSaveInFlight.current = true;
    try {
      await save();
      if (active.current && announcement) setDragAnnouncement(announcement);
    } catch {
      if (!active.current) return;
      rollback();
      onCategoryError(orderError);
    } finally {
      orderSaveInFlight.current = false;
    }
  }

  async function saveCategoryOrder(next: ChannelCategory[], announcement?: string): Promise<void> {
    setCategories(next);
    setIsReorderingCategories(true);
    try {
      await saveOrder(() => reorderCategories(next.map((category) => category.id), csrfToken), () => setCategories(categories), announcement);
    } finally {
      setIsReorderingCategories(false);
    }
  }

  function reorderCategory(direction: -1 | 1): void {
    if (isReorderingCategories || orderSaveInFlight.current) return;
    const next = swapCategories(categories, categoryIndex, categoryIndex + direction);
    if (!next) return;
    onCategoryError(null);
    void saveCategoryOrder(next);
  }

  function dropCategory(id: string, target: ReorderDropTarget): void {
    if (target.type !== "category") return;
    const from = categories.findIndex((category) => category.id === id);
    const to = categories.findIndex((category) => category.id === target.categoryId);
    const next = swapCategories(categories, from, to);
    if (next) void saveCategoryOrder(next, `Категория «${next[to]!.name}» перемещена на позицию ${to + 1}.`);
  }

  function dropChannel(id: string, target: ReorderDropTarget): void {
    const previous = channelsRef.current;
    const next = reorderChannel(previous, categories, id, target);
    if (!next) return;
    const categoryName = categories.find((category) => category.id === target.categoryId)?.name ?? "Без категории";
    replaceChannels(next.channels);
    void saveOrder(
      () => reorderChannels(next.groups, csrfToken),
      () => replaceChannels(previous),
      `Канал «${next.movedChannel.name}» перемещён в категорию «${categoryName}».`
    );
  }

  function reorderItem(item: ReorderItem, target: ReorderDropTarget): void {
    if (!canManageChannels || orderSaveInFlight.current) return;
    setDragAnnouncement("");
    onCategoryError(null);
    if (item.kind === "category") dropCategory(item.id, target);
    else dropChannel(item.id, target);
  }

  async function handleCreateChannel(input: CreateChannelInput): Promise<void> {
    await createChannel(input, csrfToken);
    if (active.current) await refreshChannelList(true);
  }

  function handleCreateCategory(name: string): Promise<void> {
    return submitCategory(name, async () => {
      await createCategory(name, csrfToken);
      if (!active.current) return;
      const data = await getChannels();
      if (active.current) setCategories(data.categories);
    });
  }

  function handleRenameCategory(name: string): Promise<void> {
    return submitCategory(name, async () => {
      if (!renameTarget) throw new Error("Не удалось подготовить защищённый запрос");
      const updated = await renameCategory(renameTarget.id, name, csrfToken);
      if (active.current) setCategories((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
    });
  }

  async function handleMoveChannel(categoryId: string | null): Promise<void> {
    if (!moveTarget) throw new Error("Channel unavailable");
    const moved = await moveChannelToCategory(moveTarget.id, categoryId, csrfToken);
    if (!active.current) return;
    replaceChannels(placeChannelAtCategoryEnd(channelsRef.current, categories, moved));
    refreshAfterEdit(false);
  }

  async function confirmDeleteCategory(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteError(undefined);
    setIsDeleting(true);
    try {
      await deleteCategory(deleteTarget.id, csrfToken);
      if (!active.current) return;
      replaceChannels(channelsRef.current.map((channel) =>
        channel.categoryId === deleteTarget.id ? { ...channel, categoryId: null } : channel
      ));
      setCategories((current) => current.filter((category) => category.id !== deleteTarget.id));
      setDeleteTarget(null);
      categoryTrigger.current = null;
    } catch {
      setDeleteError("Не удалось удалить категорию. Попробуйте ещё раз.");
    } finally {
      setIsDeleting(false);
    }
  }

  function restoreCategoryFocus(): void {
    const trigger = categoryTrigger.current;
    window.requestAnimationFrame(() => trigger?.focus());
  }

  function reportCategoryError(message: string | null): void {
    if (active.current) onCategoryError(message);
  }

  return (
    <>
      <ChannelSidebar
        {...sidebar}
        onCategoryError={reportCategoryError}
        onCreateChannel={openCreateChannel}
        onCreateCategory={handleCreateCategory}
        onReorderItem={reorderItem}
        dragAnnouncement={dragAnnouncement}
        onOpenCategoryMenu={(id, trigger) => openActionMenu("category", id, trigger)}
        openCategoryMenuId={categoryMenuId}
        onOpenChannelMenu={(id, trigger) => openActionMenu("channel", id, trigger)}
        openChannelMenuId={channelMenuId}
      />
      {channelForMenu && (
        <ChannelMenu
          name={channelForMenu.name}
          trigger={channelTrigger.current}
          canEditProperties={channelForMenu.ownerEditable}
          onProperties={() => onPropertiesTargetChange(channelForMenu)}
          onMove={() => setMoveTarget(channelForMenu)}
          onClose={() => setOpenMenu(null)}
        />
      )}
      {moveTarget && (
        <MoveToCategoryMenu
          open
          channelName={moveTarget.name}
          currentCategoryId={moveTarget.categoryId}
          categories={categories}
          onClose={() => {
            setMoveTarget(null);
            window.requestAnimationFrame(() => channelTrigger.current?.focus());
          }}
          onMove={handleMoveChannel}
        />
      )}
      <CreateChannelModal
        open={createTarget !== undefined}
        category={createTarget ?? null}
        onClose={() => setCreateTarget(undefined)}
        onCreate={handleCreateChannel}
        onSessionExpired={expireSession}
      />
      {propertiesTarget && (
        <ChannelPropertiesModal
          open
          channelId={propertiesTarget.id}
          categories={categories}
          csrfToken={csrfToken}
          canManage={propertiesTarget.ownerEditable}
          onClose={() => {
            setOpenMenu((current) => current?.kind === "channel" ? null : current);
            onPropertiesTargetChange(null);
          }}
          onSessionExpired={expireSession}
          onSaved={() => refreshAfterEdit(true)}
        />
      )}
      {categoryForMenu && (
        <ChannelCategoryMenu
          name={categoryForMenu.name}
          trigger={categoryTrigger.current}
          expanded={!sidebar.collapsedCategoryIds.has(categoryForMenu.id)}
          canMoveUp={!isReorderingCategories && categoryIndex > 0}
          canMoveDown={!isReorderingCategories && categoryIndex < categories.length - 1}
          onToggle={() => sidebar.onToggleCategoryCollapsed(categoryForMenu.id)}
          onRename={() => setRenameTarget(categoryForMenu)}
          onDelete={() => {
            setDeleteError(undefined);
            setDeleteTarget(categoryForMenu);
          }}
          onMoveUp={() => reorderCategory(-1)}
          onMoveDown={() => reorderCategory(1)}
          onClose={() => setOpenMenu(null)}
        />
      )}
      <CategoryDialog
        open={renameTarget !== null}
        onClose={() => {
          setRenameTarget(null);
          restoreCategoryFocus();
        }}
        mode="rename"
        {...(renameTarget ? { initialName: renameTarget.name } : {})}
        onSubmit={handleRenameCategory}
        onError={reportCategoryError}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Удалить категорию «${deleteTarget?.name ?? ""}»`}
        description="Каналы этой категории перейдут в раздел «Без категории». Переписка не пропадёт."
        confirmCheckboxLabel="Подтверждаю удаление категории и перенос её каналов в «Без категории»"
        confirmLabel="Удалить"
        onConfirm={confirmDeleteCategory}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(undefined);
          restoreCategoryFocus();
        }}
        busy={isDeleting}
        {...(deleteError ? { errorMessage: deleteError } : {})}
      />
    </>
  );
}
