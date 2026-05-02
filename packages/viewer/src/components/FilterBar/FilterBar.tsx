import * as Popover from '@radix-ui/react-popover';
import type { FilterState } from '../../state/filters.ts';
import type { BugKind, Severity, ClusterVerdict } from '../../types.ts';
import styles from './FilterBar.module.css';

const BUG_KINDS: BugKind[] = [
  'console_error', 'react_error', 'hydration_mismatch', 'network_5xx', 'network_4xx_unexpected',
  'accessibility_critical', 'dom_error_text', 'visual_anomaly', 'xss_reflected', 'xss_dom',
  'sql_injection', 'path_traversal', 'idor_horizontal_read', 'idor_horizontal_mutate',
];

const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'info'];

const VERDICTS: ClusterVerdict[] = [
  'verified_fixed', 'verified_fixed_by_removal', 'not_fixed', 'partially_verified', 'architect_refused',
];

type Props = {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
};

export function FilterBar({ filters, onChange }: Props) {
  const activeCount =
    filters.kinds.length +
    filters.roles.length +
    filters.severities.length +
    filters.verdicts.length +
    (filters.pageRouteContains !== '' ? 1 : 0) +
    (filters.thirdPartyOrGenerated !== 'include' ? 1 : 0);

  return (
    <div className={styles.root} role="toolbar" aria-label="Cluster filters">
      <FilterPopover
        label="Kind"
        options={BUG_KINDS}
        selected={filters.kinds}
        onToggle={kind => onChange({ ...filters, kinds: toggle(filters.kinds, kind as BugKind) })}
      />
      <FilterPopover
        label="Severity"
        options={SEVERITIES}
        selected={filters.severities}
        onToggle={sev => onChange({ ...filters, severities: toggle(filters.severities, sev as Severity) })}
      />
      <FilterPopover
        label="Verdict"
        options={VERDICTS}
        selected={filters.verdicts}
        onToggle={verdict => onChange({ ...filters, verdicts: toggle(filters.verdicts, verdict as ClusterVerdict) })}
      />
      <ThirdPartyToggle value={filters.thirdPartyOrGenerated} onChange={tp => onChange({ ...filters, thirdPartyOrGenerated: tp })} />
      {activeCount > 0 && (
        <button
          className={styles.clearBtn}
          onClick={() => onChange({ kinds: [], roles: [], severities: [], verdicts: [], pageRouteContains: '', thirdPartyOrGenerated: 'include' })}
          aria-label="Clear all filters"
        >
          Clear ({activeCount})
        </button>
      )}
    </div>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

type FilterPopoverProps = {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
};

function FilterPopover({ label, options, selected, onToggle }: FilterPopoverProps) {
  const hasActive = selected.length > 0;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={`${styles.filterBtn} ${hasActive ? styles.active : ''}`} aria-label={`Filter by ${label}`}>
          {label}{hasActive ? ` (${selected.length})` : ''}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.popoverContent} sideOffset={4}>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{label}</legend>
            {options.map(opt => (
              <label key={opt} className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => onToggle(opt)}
                />
                {opt}
              </label>
            ))}
          </fieldset>
          <Popover.Arrow className={styles.arrow} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type ThirdPartyProps = {
  value: FilterState['thirdPartyOrGenerated'];
  onChange: (value: FilterState['thirdPartyOrGenerated']) => void;
};

function ThirdPartyToggle({ value, onChange }: ThirdPartyProps) {
  const options: FilterState['thirdPartyOrGenerated'][] = ['include', 'exclude', 'only'];
  return (
    <fieldset className={styles.inlineFieldset}>
      <legend className={styles.inlineLegend}>3rd party:</legend>
      {options.map(opt => (
        <label key={opt} className={styles.radioLabel}>
          <input
            type="radio"
            name="third-party-filter"
            value={opt}
            checked={value === opt}
            onChange={() => onChange(opt)}
          />
          {opt}
        </label>
      ))}
    </fieldset>
  );
}
