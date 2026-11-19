import type { PropsWithChildren } from "react";

export interface IconProps {
  size?: number;
  className?: string;
}

function IconFrame({ size = 20, className, children }: PropsWithChildren<IconProps>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function LogoMark(props: IconProps) {
  return <IconFrame {...props}><rect x="2" y="2" width="16" height="16" rx="4" /><path d="M8 6.5h1.8a3.5 3.5 0 0 1 0 7H8z" /></IconFrame>;
}

export function GearIcon(props: IconProps) {
  return <IconFrame {...props}><circle cx="10" cy="10" r="3" /><path d="m8.5 2.8.4 1.6a5.9 5.9 0 0 1 2.2 0l.4-1.6 2.1.9-.8 1.5a6 6 0 0 1 1.5 1.5l1.5-.8.9 2.1-1.6.4a5.9 5.9 0 0 1 0 2.2l1.6.4-.9 2.1-1.5-.8a6 6 0 0 1-1.5 1.5l.8 1.5-2.1.9-.4-1.6a5.9 5.9 0 0 1-2.2 0l-.4 1.6-2.1-.9.8-1.5a6 6 0 0 1-1.5-1.5l-1.5.8-.9-2.1 1.6-.4a5.9 5.9 0 0 1 0-2.2l-1.6-.4.9-2.1 1.5.8a6 6 0 0 1 1.5-1.5l-.8-1.5z" /></IconFrame>;
}

export function PeopleIcon(props: IconProps) {
  return <IconFrame {...props}><circle cx="7.5" cy="7" r="2.5" /><path d="M2.8 16a4.7 4.7 0 0 1 9.4 0M13.2 5a2.4 2.4 0 0 1 0 4.7M14 11.7a4.4 4.4 0 0 1 3.2 4.2" /></IconFrame>;
}

export function SunIcon(props: IconProps) {
  return <IconFrame {...props}><circle cx="10" cy="10" r="3.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4" /></IconFrame>;
}

export function MoonIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M16.5 12.5A7 7 0 0 1 7.5 3.5a7 7 0 1 0 9 9Z" /></IconFrame>;
}

export function InfoIcon(props: IconProps) {
  return <IconFrame {...props}><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5m0-8h.01" /></IconFrame>;
}

export function LockIcon(props: IconProps) {
  return <IconFrame {...props}><rect x="3.5" y="8.5" width="13" height="9" rx="2" /><path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5m-3.5 4v2" /></IconFrame>;
}

export function MenuIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M3 5h14M3 10h14M3 15h14" /></IconFrame>;
}

export function ClockIcon(props: IconProps) {
  return <IconFrame {...props}><circle cx="10" cy="10" r="7.5" /><path d="M10 5.5V10l3 2" /></IconFrame>;
}

export function CopyIcon(props: IconProps) {
  return <IconFrame {...props}><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7" /></IconFrame>;
}

export function EditIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m12.8 4.2 3 3M4 16l3.2-.7L16.5 6a1.8 1.8 0 0 0-2.5-2.5L4.7 12.8 4 16Z" /><path d="M3 18h14" /></IconFrame>;
}

export function TrashIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M4.5 6.5h11l-.8 10.2a1.5 1.5 0 0 1-1.5 1.3H6.8a1.5 1.5 0 0 1-1.5-1.3zM3 4h14m-9-1h4m-4 6v5m4-5v5" /></IconFrame>;
}

export function SendIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m2.5 9 14.8-6-5.9 14.8-2.5-6.4L2.5 9Z" /><path d="m8.9 11.4 4-4" /></IconFrame>;
}

export function CloseIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m4 4 12 12M16 4 4 16" /></IconFrame>;
}

export function SearchIcon(props: IconProps) {
  return <IconFrame {...props}><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4.2 4.2" /></IconFrame>;
}

export function UploadIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 15.5h12" /></IconFrame>;
}

export function PinIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M7.5 2.5h5l-.6 5.2 2.6 2.8v1.5H5.5v-1.5l2.6-2.8z" /><path d="M10 12v5.5" /></IconFrame>;
}

export function CheckIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m3.5 10.5 4.2 4.2 8.8-9" /></IconFrame>;
}

export function ForwardIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M3.5 10h11M10 5.5 14.5 10 10 14.5" /></IconFrame>;
}

export function CrossIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m5 5 10 10M15 5 5 15" /></IconFrame>;
}

export function WarningIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M8.4 3.5a1.8 1.8 0 0 1 3.2 0l6 10.8a1.8 1.8 0 0 1-1.6 2.7H4a1.8 1.8 0 0 1-1.6-2.7z" /><path d="M10 7v4m0 3h.01" /></IconFrame>;
}

export function ChevronIcon(props: IconProps) {
  return <IconFrame {...props}><path d="m5 7.5 5 5 5-5" /></IconFrame>;
}

export function PlusIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M10 4v12M4 10h12" /></IconFrame>;
}

export function FolderPlusIcon(props: IconProps) {
  return <IconFrame {...props}>
    <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6l1.6 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M8.5 9.5v3M7 11h3" />
  </IconFrame>;
}

export function GripIcon(props: IconProps) {
  const { size = 20, className } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="7" cy="6" r="1.2" fill="currentColor" />
      <circle cx="13" cy="6" r="1.2" fill="currentColor" />
      <circle cx="7" cy="10" r="1.2" fill="currentColor" />
      <circle cx="13" cy="10" r="1.2" fill="currentColor" />
      <circle cx="7" cy="14" r="1.2" fill="currentColor" />
      <circle cx="13" cy="14" r="1.2" fill="currentColor" />
    </svg>
  );
}
