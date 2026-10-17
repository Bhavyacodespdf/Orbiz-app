import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { describeError } from '@/lib/errors';
import { paiseToRupeesInput, parseRupeesToPaise } from '@/lib/money';
import type { StaffCategory, StaffMenuItem, ItemInput } from '@/services/staff';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().trim().max(300, 'Keep it under 300 characters'),
  price: z.string().refine((v) => {
    const paise = parseRupeesToPaise(v);
    return paise !== null && paise >= 100 && paise <= 1_000_000;
  }, 'Enter a price from ₹1 to ₹10,000, with at most 2 decimals'),
  dietary: z.enum(['', 'VEG', 'NON_VEG', 'EGG']),
  fulfillmentType: z.string().min(1, 'Choose packaged or handmade'),
  categoryId: z.string().min(1, 'Choose a category'),
});
type Values = z.infer<typeof schema>;

export function ItemDialog({
  open,
  item,
  categories,
  defaultCategoryId,
  saving,
  error,
  onSave,
  onClose,
}: {
  open: boolean;
  item: StaffMenuItem | null;
  categories: StaffCategory[];
  defaultCategoryId?: string;
  saving: boolean;
  error: unknown;
  onSave: (input: ItemInput) => void;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!open) return;
    reset({
      name: item?.name ?? '',
      description: item?.description ?? '',
      price: item ? paiseToRupeesInput(item.pricePaise) : '',
      dietary: item?.dietary ?? '',
      fulfillmentType: item?.fulfillmentType ?? '',
      categoryId: item?.categoryId ?? defaultCategoryId ?? categories[0]?.id ?? '',
    });
  }, [open, item, defaultCategoryId, categories, reset]);

  return (
    <Dialog open={open} onClose={onClose} title={item ? `Edit ${item.name}` : 'Add menu item'}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((values) =>
          onSave({
            name: values.name,
            description: values.description,
            pricePaise: parseRupeesToPaise(values.price)!,
            dietary: values.dietary === '' ? null : values.dietary,
            fulfillmentType: values.fulfillmentType as 'PACKAGED' | 'HANDMADE',
            categoryId: values.categoryId,
          }),
        )}
      >
        <TextField label="Name" error={errors.name?.message} {...register('name')} />
        <TextField
          label="Description (optional)"
          error={errors.description?.message}
          {...register('description')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Price"
            adornment="₹"
            inputMode="decimal"
            error={errors.price?.message}
            {...register('price')}
          />
          <SelectField label="Food type" {...register('dietary')}>
            <option value="">Not specified</option>
            <option value="VEG">Vegetarian</option>
            <option value="EGG">Contains egg</option>
            <option value="NON_VEG">Non-vegetarian</option>
          </SelectField>
        </div>
        <SelectField
          label="Packaged or handmade"
          error={errors.fulfillmentType?.message}
          hint="Used if a scheduled order isn’t collected: packaged food is 90% refunded and can be restocked; handmade food isn’t."
          {...register('fulfillmentType')}
        >
          <option value="">Choose…</option>
          <option value="PACKAGED">Packaged (sealed, can be resold)</option>
          <option value="HANDMADE">Handmade (made to order)</option>
        </SelectField>
        <SelectField
          label="Category"
          error={errors.categoryId?.message}
          {...register('categoryId')}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isActive ? '' : ' (hidden)'}
            </option>
          ))}
        </SelectField>
        {item && (
          <p className="text-xs text-espresso-500">
            Price changes apply to new orders only. Orders already placed keep the price they were
            placed at.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-sm font-medium text-chili-600">
            {describeError(error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {item ? 'Save changes' : 'Add item'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
