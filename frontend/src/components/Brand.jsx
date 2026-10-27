import { PawPrint } from 'lucide-react';

export default function Brand({ light = false }) {
  return (
    <a className={`brand ${light ? 'brand-light' : ''}`} href="#trang-chu" aria-label="PetCare — Trang chủ">
      <span className="brand-mark"><PawPrint size={24} strokeWidth={2.2} /></span>
      <span>Pet<span className="brand-accent">Care</span><span className="brand-dot">.</span></span>
    </a>
  );
}
