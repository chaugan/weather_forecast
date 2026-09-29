/* Applies the saved theme before the first paint (kept in its own file so the CSP can forbid inline scripts) */
try { var th = localStorage.getItem('glett.theme'); if (th === 'dark' || th === 'light') document.documentElement.setAttribute('data-theme', th); } catch (e) { /* ignore */ }
