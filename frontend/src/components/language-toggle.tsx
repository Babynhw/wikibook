import { useUi, type UiLanguage } from '@/lib/locale';

export function LanguageToggle() {
  const { language, setLanguage } = useUi();
  const next: UiLanguage = language === 'vi' ? 'en' : 'vi';
  return (
    <button
      type="button"
      aria-label={language === 'vi' ? 'Đang dùng tiếng Việt, chuyển sang tiếng Anh' : 'Using English, switch to Vietnamese'}
      onClick={() => setLanguage(next)}
      className="shrink-0 rounded border border-outline-variant px-2 py-1 font-mono text-xs text-on-surface-variant hover:bg-surface-container-low"
    >
      {language === 'vi' ? 'Tiếng Việt' : 'English'}
    </button>
  );
}