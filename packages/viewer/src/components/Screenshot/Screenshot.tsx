import { useState, useEffect } from 'react';
import styles from './Screenshot.module.css';

type Props = {
  blob: Blob | undefined;
  loading: boolean;
};

export function Screenshot({ blob, loading }: Props) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob === undefined) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  if (loading) {
    return <div className={styles.skeleton} aria-label="Loading screenshot" />;
  }

  if (objectUrl === null) {
    return (
      <div className={styles.missing} role="img" aria-label="Screenshot not available">
        <span>Screenshot not available</span>
      </div>
    );
  }

  return (
    <img
      className={styles.img}
      src={objectUrl}
      alt="Occurrence screenshot"
      loading="lazy"
    />
  );
}
