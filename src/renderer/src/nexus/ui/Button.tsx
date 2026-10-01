import type { ReactNode } from 'react';
import { Icon, type NexusIconName } from '../icons';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  icon?: NexusIconName;
  children?: ReactNode;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  onClick?: () => void;
  ariaLabel?: string;
}

export function Button({ variant = 'secondary', size = 'md', icon, children, disabled, title, type = 'button', onClick, ariaLabel }: ButtonProps) {
  return (
    <button
      type={type}
      className={`nx-btn nx-btn--${variant} nx-btn--${size}`}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  );
}
