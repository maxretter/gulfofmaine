interface Option<T> {
  value: T;
  label: string;
}

interface Props<T extends string | number> {
  /** The select's accessible name: the words the sentence around it leaves out, such as "Depth". */
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}

/** A choice made inside a title or sentence, set in the text's own type. */
export function InlineSelect<T extends string | number>({ label, value, options, onChange }: Props<T>) {
  return (
    <span className="inline-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(options[e.target.selectedIndex].value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
