// Populate the shared coming-soon page based on the `?product=` query param
// injected by vercel.json rewrites (e.g. `/voice/receptionist/live` →
// `/coming-soon.html?product=receptionist`).

const PRODUCTS = {
  receptionist: {
    title: 'Receptionist',
    category: 'Voice AI',
    eyebrow: 'Voice AI · Inbound',
    marketingPath: '/voice/receptionist',
    categoryPath: '/voice',
  },
  'website-voice-bot': {
    title: 'Website Voice Bot',
    category: 'Voice AI',
    eyebrow: 'Voice AI · Embedded',
    marketingPath: '/voice/website-voice-bot',
    categoryPath: '/voice',
  },
  'web-bot': {
    title: 'Web Bot',
    category: 'Web',
    eyebrow: 'Web · Chat',
    marketingPath: '/web-bot',
    categoryPath: '/',
  },
  'dashboard-demo': {
    title: 'Command Dashboard',
    category: 'Leadership',
    eyebrow: 'Leadership',
    marketingPath: '/dashboard-demo',
    categoryPath: '/',
  },
};

function getProductKey() {
  const params = new URLSearchParams(location.search);
  return params.get('product') || '';
}

(function init() {
  const key = getProductKey();
  const cfg = PRODUCTS[key];
  if (!cfg) {
    document.getElementById('product-title').textContent = 'This';
    document.getElementById('eyebrow').textContent = 'Launching soon';
    document.getElementById('crumb-category').textContent = 'Demos';
    const link = document.getElementById('crumb-product-link');
    link.textContent = '—';
    link.href = '/';
    document.getElementById('back-to-product').href = '/';
    return;
  }

  document.title = `${cfg.title} live demo — Agenticz`;
  document.getElementById('product-title').textContent = cfg.title;
  document.getElementById('eyebrow').textContent = cfg.eyebrow;

  // Breadcrumb: if the category has its own page (Voice AI), link to it;
  // otherwise just show the category text.
  const categoryEl = document.getElementById('crumb-category');
  if (cfg.categoryPath && cfg.categoryPath !== '/') {
    const a = document.createElement('a');
    a.href = cfg.categoryPath;
    a.textContent = cfg.category;
    categoryEl.replaceWith(a);
    a.id = 'crumb-category';
  } else {
    categoryEl.textContent = cfg.category;
  }

  const productLink = document.getElementById('crumb-product-link');
  productLink.href = cfg.marketingPath;
  productLink.textContent = cfg.title;

  const back = document.getElementById('back-to-product');
  back.href = cfg.marketingPath;
  back.textContent = `Back to ${cfg.title}`;
})();
