import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/lib/locale';
import { LanguageToggle } from './language-toggle';

describe('LanguageToggle', () => {
  it('switches the current UI language and persists it', () => {
    localStorage.clear();
    render(
      <LanguageProvider>
        <LanguageToggle />
      </LanguageProvider>,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Tiếng Việt');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('English');
    expect(localStorage.getItem('wikibooklm-language')).toBe('en');

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('Tiếng Việt');
    expect(localStorage.getItem('wikibooklm-language')).toBe('vi');
  });
});
