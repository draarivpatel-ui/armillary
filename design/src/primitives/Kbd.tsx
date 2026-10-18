import React from "react";

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

export const Kbd: React.FC<KbdProps> = ({ children, className = "", ...props }) => {
  return (
    <kbd className={`obs-kbd ${className}`.trim()} {...props}>
      {children}
    </kbd>
  );
};
