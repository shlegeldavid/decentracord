import { useState, type Dispatch, type SetStateAction } from "react";
import {
  createCategory,
  deleteCategory,
  reorderCategories,
  renameCategory,
  type Channel,
  type ChannelCategory
} from "../../api";
import { swapCategories } from "../../lib/channelOrder";
import { CategoryDialog } from "../CategoryDialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";

interface ChannelCategorySettingsProps {
  categories: ChannelCategory[];
  channels: Channel[];
  setCategories: Dispatch<SetStateAction<ChannelCategory[]>>;
  csrfToken: string;
  isLoading: boolean;
  onDeleteCategory: (categoryId: string) => void;
  onRequestError: (error: unknown) => string;
  onError: (message: string) => void;
}

type CategoryDialogState = { mode: "create" } | { mode: "rename"; category: ChannelCategory };

function channelCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = last === 1 && lastTwo !== 11
    ? "канал"
    : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
      ? "канала"
      : "каналов";
  return `${count} ${word}`;
}

export function ChannelCategorySettings({
  categories,
  channels,
  setCategories,
  csrfToken,
  isLoading,
  onDeleteCategory,
  onRequestError,
  onError
}: ChannelCategorySettingsProps) {
  const [dialog, setDialog] = useState<CategoryDialogState | null>(null);
  const [categoryDeleteTarget, setCategoryDeleteTarget] = useState<ChannelCategory | null>(null);
  const [categoryDeleteError, setCategoryDeleteError] = useState<string | undefined>(undefined);
  const [categoryOrderError, setCategoryOrderError] = useState<string | null>(null);
  const [isDeletingCategory, setIsDeletingCategory] = useState(false);
  const [isReorderingCategories, setIsReorderingCategories] = useState(false);

  async function handleCategoryDialogSubmit(name: string): Promise<void> {
    if (!dialog) return;
    try {
      if (dialog.mode === "create") {
        const created = await createCategory(name, csrfToken);
        setCategories((current) => [...current, created].sort((left, right) => left.position - right.position));
      } else {
        const updated = await renameCategory(dialog.category.id, name, csrfToken);
        setCategories((current) => current.map((category) => category.id === updated.id ? updated : category));
      }
    } catch (error) {
      throw new Error(onRequestError(error));
    }
  }

  async function handleReorderCategory(categoryId: string, direction: -1 | 1): Promise<void> {
    if (isReorderingCategories) return;
    const current = categories;
    const index = current.findIndex((category) => category.id === categoryId);
    const next = swapCategories(current, index, index + direction);
    if (!next) return;
    setCategories(next);
    setCategoryOrderError(null);
    setIsReorderingCategories(true);
    try {
      await reorderCategories(next.map((category) => category.id), csrfToken);
    } catch (error) {
      onRequestError(error);
      setCategories(current);
      setCategoryOrderError("Не удалось сохранить порядок. Попробуйте ещё раз.");
    } finally {
      setIsReorderingCategories(false);
    }
  }

  async function handleDeleteCategory(): Promise<void> {
    const target = categoryDeleteTarget;
    if (!target) return;
    setCategoryDeleteError(undefined);
    setIsDeletingCategory(true);
    try {
      await deleteCategory(target.id, csrfToken);
      setCategories((current) => current.filter((category) => category.id !== target.id));
      onDeleteCategory(target.id);
      setCategoryDeleteTarget(null);
    } catch (error) {
      onRequestError(error);
      setCategoryDeleteError("Не удалось удалить категорию. Попробуйте ещё раз.");
    } finally {
      setIsDeletingCategory(false);
    }
  }

  return (
    <>
      <section className="settings-category-section" aria-label="Категории" aria-busy={isLoading || isReorderingCategories}>
        <h3>Категории</h3>
        <button
          type="button"
          className="btn-primary settings-category-create"
          onClick={() => setDialog({ mode: "create" })}
        >
          Создать категорию
        </button>
        {categoryOrderError && <p className="channel-dialog-error" role="alert">{categoryOrderError}</p>}
        {isLoading ? (
          <p className="loading-copy" aria-live="polite">Загружаем категории…</p>
        ) : categories.length === 0 ? (
          <p className="settings-category-empty">Категорий пока нет.</p>
        ) : (
          <div className="settings-category-list">
            {categories.map((category, index) => (
              <div className="settings-category-row" data-category-id={category.id} key={category.id}>
                <span className="settings-category-count">
                  {channelCountLabel(channels.filter((channel) => channel.categoryId === category.id).length)}
                </span>
                <span className="channel-category-name">{category.name}</span>
                <span aria-hidden="true" />
                <div className="settings-category-order">
                  <button
                    type="button"
                    disabled={isReorderingCategories || index === 0}
                    onClick={() => void handleReorderCategory(category.id, -1)}
                  >
                    Выше
                  </button>
                  <button
                    type="button"
                    disabled={isReorderingCategories || index === categories.length - 1}
                    onClick={() => void handleReorderCategory(category.id, 1)}
                  >
                    Ниже
                  </button>
                </div>
                <button
                  type="button"
                  disabled={isReorderingCategories}
                  onClick={() => setDialog({ mode: "rename", category })}
                >
                  Переименовать
                </button>
                <button
                  type="button"
                  className="button-danger"
                  disabled={isDeletingCategory || isReorderingCategories}
                  onClick={() => {
                    setCategoryDeleteError(undefined);
                    setCategoryDeleteTarget(category);
                  }}
                >
                  Удалить
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <CategoryDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        mode={dialog?.mode ?? "create"}
        {...(dialog?.mode === "rename" ? { initialName: dialog.category.name } : {})}
        onSubmit={handleCategoryDialogSubmit}
        onError={onError}
      />
      <ConfirmDialog
        open={categoryDeleteTarget !== null}
        title={`Удалить категорию «${categoryDeleteTarget?.name ?? ""}»`}
        description="Каналы этой категории перейдут в раздел «Без категории». Переписка не пропадёт."
        confirmCheckboxLabel="Подтверждаю удаление категории и перенос её каналов в «Без категории»"
        confirmLabel="Удалить"
        onConfirm={handleDeleteCategory}
        onCancel={() => {
          if (isDeletingCategory) return;
          setCategoryDeleteTarget(null);
          setCategoryDeleteError(undefined);
        }}
        busy={isDeletingCategory}
        {...(categoryDeleteError ? { errorMessage: categoryDeleteError } : {})}
      />
    </>
  );
}
