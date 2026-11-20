import { useState } from 'react';

import { Input } from '@/components/ui/input';

interface TagInputProps {
  id?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

/** A chip input: type a tag and press Enter or comma (or leave the box) to add it. */
export function TagInput({ id, value, onChange, disabled }: TagInputProps) {
  const [draft, setDraft] = useState('');

  function add(text: string) {
    const fresh = text
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t && !value.some((v) => v.toLowerCase() === t.toLowerCase()));
    if (fresh.length > 0) onChange([...value, ...new Set(fresh)]);
    setDraft('');
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Tags">
          {value.map((tag) => (
            <li
              key={tag}
              className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-sm"
            >
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                disabled={disabled}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((v) => v !== tag))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        value={draft}
        disabled={disabled}
        placeholder="Type a tag, then press Enter or comma"
        onChange={(e) => {
          if (e.target.value.includes(',')) add(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
      />
    </div>
  );
}
