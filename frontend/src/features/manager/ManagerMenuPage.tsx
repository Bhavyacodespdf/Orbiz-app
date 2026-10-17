import { useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, UtensilsCrossed } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Dialog } from '@/components/ui/Dialog';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Price } from '@/components/ui/Price';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import {
  useCreateCategory,
  useCreateItem,
  useSetAvailability,
  useStaffMenu,
  useUpdateCategory,
  useUpdateItem,
  type StaffCategory,
  type StaffMenuItem,
  type StaffOutlet,
} from '@/services/staff';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import { StockBadge } from '@/features/inventory/StockBadge';
import { FulfillmentChip } from '@/features/noshow/NoShowPanel';
import { ItemDialog } from './ItemDialog';

function AvailabilitySwitch({
  item,
  onToggle,
  busy,
}: {
  item: StaffMenuItem;
  onToggle: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!item.soldOutManually}
      aria-label={`${item.name} available`}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        !item.soldOutManually ? 'bg-success-600' : 'bg-espresso-200',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform',
          !item.soldOutManually && 'translate-x-5',
        )}
      />
    </button>
  );
}

function MenuEditor({
  current,
  outlets,
  select,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
}) {
  const outletId = current.outlet.id;
  const isManager = current.roles.includes('MANAGER');
  const menu = useStaffMenu(outletId);
  const toast = useToast();
  const createCategory = useCreateCategory(outletId);
  const updateCategory = useUpdateCategory(outletId);
  const createItem = useCreateItem(outletId);
  const updateItem = useUpdateItem(outletId);
  const setAvailability = useSetAvailability(outletId);

  const [newCategory, setNewCategory] = useState('');
  const [editing, setEditing] = useState<{
    item: StaffMenuItem | null;
    categoryId?: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<StaffCategory | null>(null);
  const [renameTo, setRenameTo] = useState('');

  const fail = (title: string) => (error: unknown) =>
    toast.show({ tone: 'error', title, description: describeError(error) });

  if (menu.isPending) return <Skeleton className="h-64 w-full" />;
  if (menu.error)
    return (
      <ErrorState
        error={menu.error}
        onRetry={() => void menu.refetch()}
        retrying={menu.isFetching}
      />
    );
  const { categories, items } = menu.data;
  const saving = createItem.isPending || updateItem.isPending;

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Menu"
        description={`${current.outlet.name} · changes are visible to students right away.`}
        actions={<OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />}
      />

      {isManager && (
        <form
          className="mb-6 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newCategory.trim()) return;
            createCategory.mutate(
              { name: newCategory.trim() },
              { onSuccess: () => setNewCategory(''), onError: fail('Couldn’t add the category') },
            );
          }}
        >
          <TextField
            label="New category"
            placeholder="e.g. Breakfast"
            value={newCategory}
            maxLength={40}
            onChange={(e) => setNewCategory(e.target.value)}
            className="w-full sm:w-72"
          />
          <Button
            type="submit"
            variant="secondary"
            loading={createCategory.isPending}
            icon={<Plus className="size-4" aria-hidden />}
          >
            Add category
          </Button>
        </form>
      )}

      {categories.length === 0 ? (
        <EmptyState
          icon={<UtensilsCrossed aria-hidden />}
          title="No categories yet"
          description={
            isManager
              ? 'Add a category above, then add items to it.'
              : 'The manager hasn’t set up this menu yet.'
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {categories.map((category) => {
            const categoryItems = items.filter((i) => i.categoryId === category.id);
            return (
              <Panel
                key={category.id}
                className={cn('p-4', !category.isActive && 'border-dashed bg-cream-200')}
              >
                <section aria-label={category.name}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h2 className="font-sans text-sm font-bold tracking-[0.14em] uppercase">
                      {category.name}
                    </h2>
                    {!category.isActive && <Badge>Hidden from students</Badge>}
                    {isManager && (
                      <div className="ml-auto flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRenaming(category);
                            setRenameTo(category.name);
                          }}
                          icon={<Pencil className="size-4" aria-hidden />}
                        >
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={
                            category.isActive ? (
                              <EyeOff className="size-4" aria-hidden />
                            ) : (
                              <Eye className="size-4" aria-hidden />
                            )
                          }
                          onClick={() =>
                            updateCategory.mutate(
                              { categoryId: category.id, isActive: !category.isActive },
                              { onError: fail('Couldn’t update the category') },
                            )
                          }
                        >
                          {category.isActive ? 'Hide category' : 'Show category'}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Plus className="size-4" aria-hidden />}
                          onClick={() => setEditing({ item: null, categoryId: category.id })}
                        >
                          Add item
                        </Button>
                      </div>
                    )}
                  </div>
                  {categoryItems.length === 0 ? (
                    <p className="py-3 text-sm text-espresso-500">No items in this category.</p>
                  ) : (
                    <ul>
                      {categoryItems.map((item) => (
                        <li
                          key={item.id}
                          className={cn(
                            'flex flex-wrap items-center gap-3 border-b border-dashed border-espresso-100 py-3 last:border-b-0',
                          )}
                        >
                          {item.dietary ? (
                            <DietaryMark dietary={item.dietary} />
                          ) : (
                            <span className="w-4" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p
                              className={cn('font-semibold', !item.isActive && 'text-espresso-500')}
                            >
                              {item.name} {!item.isActive && <Badge className="ml-1">Hidden</Badge>}{' '}
                              <FulfillmentChip type={item.fulfillmentType} />
                            </p>
                            {item.description && (
                              <p className="truncate text-sm text-espresso-500">
                                {item.description}
                              </p>
                            )}
                          </div>
                          <Price paise={item.pricePaise} className="w-20 text-right" />
                          <label className="flex items-center gap-2 text-sm text-espresso-700">
                            <AvailabilitySwitch
                              item={item}
                              busy={
                                setAvailability.isPending &&
                                setAvailability.variables?.itemId === item.id
                              }
                              onToggle={() =>
                                setAvailability.mutate(
                                  { itemId: item.id, isAvailable: item.soldOutManually },
                                  { onError: fail('Couldn’t change availability') },
                                )
                              }
                            />
                            <StockBadge
                              status={item.stockStatus}
                              audience="staff"
                              className="w-24"
                            />
                          </label>
                          {isManager && (
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditing({ item })}
                                aria-label={`Edit ${item.name}`}
                                icon={<Pencil className="size-4" aria-hidden />}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`${item.isActive ? 'Hide' : 'Show'} ${item.name}`}
                                onClick={() =>
                                  updateItem.mutate(
                                    { itemId: item.id, isActive: !item.isActive },
                                    { onError: fail('Couldn’t update the item') },
                                  )
                                }
                              >
                                {item.isActive ? 'Hide' : 'Show'}
                              </Button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </Panel>
            );
          })}
        </div>
      )}

      <ItemDialog
        open={editing !== null}
        item={editing?.item ?? null}
        defaultCategoryId={editing?.categoryId}
        categories={categories}
        saving={saving}
        error={createItem.error ?? updateItem.error}
        onClose={() => {
          setEditing(null);
          createItem.reset();
          updateItem.reset();
        }}
        onSave={(input) => {
          const done = {
            onSuccess: () => {
              setEditing(null);
              toast.show({ tone: 'success', title: 'Menu updated' });
            },
          };
          if (editing?.item) updateItem.mutate({ itemId: editing.item.id, ...input }, done);
          else createItem.mutate(input, done);
        }}
      />

      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} title="Rename category">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!renaming || !renameTo.trim()) return;
            updateCategory.mutate(
              { categoryId: renaming.id, name: renameTo.trim() },
              { onSuccess: () => setRenaming(null), onError: fail('Couldn’t rename the category') },
            );
          }}
        >
          <TextField
            label="Category name"
            value={renameTo}
            maxLength={40}
            onChange={(e) => setRenameTo(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="submit" loading={updateCategory.isPending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export function ManagerMenuPage() {
  return <StaffGate role="MANAGER">{(ctx) => <MenuEditor {...ctx} />}</StaffGate>;
}
