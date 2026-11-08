import { Link } from 'wouter';
import { useStore } from '@/lib/store-context';

const cats = [
  { key: 'category_makeup', href: '/collection?cat=makeup', img: '/images/beauty-makeup.jpg' },
  { key: 'category_skincare', href: '/collection?cat=skincare', img: '/images/beauty-skincare.jpg' },
  { key: 'category_faceFoundation', href: '/collection?cat=makeup&family=face-foundation', img: '/images/beauty-complexion.jpg' },
  { key: 'category_beautyTools', href: '/collection?cat=beautyCare&family=beauty-tools', img: '/images/beauty-tools.jpg' },
] as const;

export function CategoryGrid() {
  const { t } = useStore();
  return <div className="mc-cats">
    {cats.map(({ key, href, img }, i) => <Link key={key} href={href} className="mc-cat" style={{ animationDelay: `${120 + i * 60}ms` }} data-testid={`link-category-${key}`}>
      <span className="mc-cat-art"><img src={img} alt="" loading="lazy"/></span>
      <span className="mc-cat-label">{t(key)}</span>
    </Link>)}
  </div>;
}
