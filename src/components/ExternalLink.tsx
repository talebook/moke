'use client';

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { externalLinkClick } from '@/lib/external-link';

interface ExternalLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children: ReactNode;
}

/**
 * An anchor that opens a URL outside the app instead of navigating the WebView.
 * Keep `target` off the element so the shell plugin's `_blank` click handler
 * cannot intercept it.
 */
export function ExternalLink({ href, children, ...rest }: ExternalLinkProps) {
  return (
    <a {...rest} href={href} onClick={externalLinkClick(href)}>
      {children}
    </a>
  );
}
