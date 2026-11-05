import { useId } from "react";

/** A short set of mutually exclusive choices (Any / Yes / No) as native radios styled as one control. */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className="field inline">
      <span className="label" id={`${id}-l`}>{label}</span>
      <div className="segctl" role="radiogroup" aria-labelledby={`${id}-l`}>
        {options.map(([v, text]) => (
          <label key={v || "__any"} className={v === value ? "on" : undefined}>
            <input type="radio" name={id} value={v} checked={v === value} onChange={() => onChange(v)} />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
