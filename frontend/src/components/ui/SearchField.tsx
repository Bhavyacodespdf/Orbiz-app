import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-12 items-center gap-2 rounded-full border border-espresso-200 bg-cream-50 px-4 shadow-press transition-colors focus-within:border-chili-500 focus-within:ring-2 focus-within:ring-chili-100',
        className,
      )}
    >
      <Search className="size-5 shrink-0 text-espresso-500" aria-hidden />
      <input
        type="search"
        aria-label={label}
        value={value}
        maxLength={60}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-full w-full min-w-0 bg-transparent text-espresso-900 outline-none placeholder:text-espresso-500 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="rounded-full p-1 text-espresso-500 hover:bg-espresso-50 hover:text-espresso-900"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
