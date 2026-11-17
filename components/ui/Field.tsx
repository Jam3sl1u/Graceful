import {
  useId,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon } from "./Icon";
import styles from "./Field.module.css";

/** Class for a bare input/select/textarea that is not wrapped in <Field>. */
export const controlClassName = styles.control;

type FieldShellProps = {
  label: string;
  /** Hide the label visually (it is still the accessible name). */
  hideLabel?: boolean;
  optional?: boolean;
  hint?: React.ReactNode;
  error?: string | null;
  className?: string;
};

type ControlIds = { id: string; describedBy: string | undefined; invalid: true | undefined };

function FieldShell({
  label,
  hideLabel,
  optional,
  hint,
  error,
  className,
  id,
  children,
}: FieldShellProps & { id: string; children: (ids: ControlIds) => React.ReactNode }) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className={`${styles.field} ${className ?? ""}`}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : styles.label}>
        {label}
        {optional ? <span className={styles.optional}> (optional)</span> : null}
      </label>
      {children({ id, describedBy: describedBy || undefined, invalid: error ? true : undefined })}
      {hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={styles.error}>
          <Icon name="alert" size={16} />
          {error}
        </span>
      ) : null}
    </div>
  );
}

type InputFieldProps = FieldShellProps & Omit<InputHTMLAttributes<HTMLInputElement>, "className">;

/** Labelled text input with hint and an error tied to it via aria-describedby. */
export function InputField({ label, hideLabel, optional, hint, error, className, id, ...props }: InputFieldProps) {
  const autoId = useId();
  return (
    <FieldShell {...{ label, hideLabel, optional, hint, error, className }} id={id ?? autoId}>
      {(ids) => (
        <input
          id={ids.id}
          className={styles.control}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid}
          {...props}
        />
      )}
    </FieldShell>
  );
}

type TextareaFieldProps = FieldShellProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">;

export function TextareaField({
  label,
  hideLabel,
  optional,
  hint,
  error,
  className,
  id,
  ...props
}: TextareaFieldProps) {
  const autoId = useId();
  return (
    <FieldShell {...{ label, hideLabel, optional, hint, error, className }} id={id ?? autoId}>
      {(ids) => (
        <textarea
          id={ids.id}
          className={styles.control}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid}
          {...props}
        />
      )}
    </FieldShell>
  );
}

type SelectFieldProps = FieldShellProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, "className">;

export function SelectField({
  label,
  hideLabel,
  optional,
  hint,
  error,
  className,
  id,
  children,
  ...props
}: SelectFieldProps) {
  const autoId = useId();
  return (
    <FieldShell {...{ label, hideLabel, optional, hint, error, className }} id={id ?? autoId}>
      {(ids) => (
        <select
          id={ids.id}
          className={styles.control}
          aria-describedby={ids.describedBy}
          aria-invalid={ids.invalid}
          {...props}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}
