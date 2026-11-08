import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight } from 'lucide-react';
import { useStore } from '@/lib/store-context';

export default function Welcome() {
  const { t } = useStore();
  const [, navigate] = useLocation();
  const [leaving, setLeaving] = useState(false);
  const start = () => {
    localStorage.setItem('maya-welcomed', '1');
    setLeaving(true);
    window.setTimeout(() => navigate('/'), 420);
  };
  return <section className={`mc-wel ${leaving ? 'is-leaving' : ''}`} data-testid="page-welcome">
    <img src="/images/beauty-hero.jpg" alt="Maya Beauty cosmetics and skincare collection" className="mc-wel-bg" dir="ltr" fetchPriority="high"/>
    <div className="mc-wel-shade"/>
    <div className="mc-wel-top">
      <div className="mc-wel-brand" dir="ltr"><span/><img src="/images/maya-emblem.png" alt="" className="mc-wel-emblem"/><strong>MAYA BEAUTY</strong><span/></div>
      <h1><span>{t('welcomeTitle1')}</span><em>{t('welcomeTitle2')}</em></h1>
      <p>{t('welcomeBody')}</p>
    </div>
    <div className="mc-wel-cta">
      <button onClick={start} data-testid="button-get-started"><span>{t('getStarted')}</span><ArrowRight className="mc-flip"/></button>
    </div>
  </section>;
}
