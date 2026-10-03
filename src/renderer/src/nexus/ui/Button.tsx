import type { ReactNode } from 'react';
import { Icon, type NexusIconName } from '../icons';

export interface ButtonProps {
  /** secondary: bordered (default); primary: ink; quiet: borderless. */
  variant?: 'primary' | 'secondary' | 'quiet';
  icon?: NexusIconName;
  children?: ReactNode;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  onClick?: () => void;
  ariaLabel?: string;
}

const VARIANT_CLASS = { primary: ' nx-btn--primary', secondary: '', quiet: ' nx-btn--quiet' } as const;

export function Button({ variant = 'secondary', icon, children, disabled, title, type = 'button', onClick, ariaLabel }: ButtonProps) {
  return (
    <button
      type={type}
      className={`nx-btn${VARIANT_CLASS[variant]}`}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={15} />}
      {children && <span>{children}</span>}
    </button>
  );
}
