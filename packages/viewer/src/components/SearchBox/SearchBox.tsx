import { useRef, useEffect } from 'react';
import styles from './SearchBox.module.css';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onFocusRequested?: (cb: () => void) => void;
};

export function SearchBox({ value, onChange, onFocusRequested }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (onFocusRequested === undefined) return;
    onFocusRequested(() => {
      inputRef.current?.focus();
    });
  }, [onFocusRequested]);

  return (
    <div className={styles.root}>
      <label htmlFor="cluster-search" className={styles.label}>
        Search
      </label>
      <input
        ref={inputRef}
        id="cluster-search"
        type="search"
        className={styles.input}
        placeholder="Search root cause, kind, file…"
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-label="Search clusters"
      />
    </div>
  );
}
