import React from 'react';
import { motion } from 'motion/react';
import { ImageWithFallback } from './figma/ImageWithFallback';

import logoImg from "figma:asset/8955b1b0dd83edeebd91eddeb7a714835db252fc.png";
import heartIcon from "figma:asset/50259fba1387ec21234a7ce4be6260ee91eb83c9.png";
import bgImage from "figma:asset/012f4ef286aff8b7b44a055c885eb4a120825935.png";

// Constants based on brand guidelines
const COLORS = {
  bgBase: '#FFFFFF',
  bgPattern: '#F1F5F9',
  textPrimary: '#0F172A',
  textSecondary: '#64748B',
  accentMagenta: '#FF007F',
  accentCyan: '#06B6D4',
  glassBg: 'rgba(255, 255, 255, 0.7)',
  glassBorder: 'rgba(255, 255, 255, 0.8)',
  glassShadow: '0 20px 25px -5px rgba(15, 23, 42, 0.05)',
};

/**
 * A helper component that scales text to fit its container
 */
const AutoFitText: React.FC<{ 
  text: string; 
  className?: string;
  maxFontSize?: number;
  minFontSize?: number;
}> = ({ text, className, maxFontSize = 300, minFontSize = 40 }) => {
  const length = text.length;
  let size = maxFontSize;
  
  if (length > 10) size = 260;
  if (length > 20) size = 200;
  if (length > 40) size = 150;
  if (length > 60) size = 100;
  if (length > 100) size = 80;
  
  const finalSize = Math.max(minFontSize, size);

  return (
    <div 
      className={className}
      style={{ 
        fontSize: `${Math.min(finalSize, 920 / (Math.max(...text.split(/\s+/).map(w => w.length), 1) * 0.65))}px`,
        lineHeight: 0.9,
        fontWeight: 700,
        letterSpacing: '-0.04em',
        wordBreak: 'normal',
        overflowWrap: 'normal',
        textAlign: 'center',
        fontFamily: "'Space Grotesk', sans-serif",
        color: COLORS.textPrimary
      }}
    >
      {text}
    </div>
  );
};

// Slide Base Component
interface SlideBaseProps {
  children: React.ReactNode;
  slideNumber: number;
  totalSlides?: number;
}

export const SlideBase: React.FC<SlideBaseProps> = ({ children, slideNumber, totalSlides = 10 }) => {
  return (
    <div 
      className="relative flex flex-col overflow-hidden select-none"
      style={{
        width: '1080px',
        height: '1350px',
        backgroundColor: COLORS.bgBase,
        color: COLORS.textPrimary,
        fontFamily: "'Inter', sans-serif",
      }}
    >
      {/* Google Fonts Import */}
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;500;600&display=swap');
      `}} />

      {/* Custom Background Image */}
      <div className="absolute inset-0 pointer-events-none opacity-60">
        <img 
          src={bgImage} 
          alt="" 
          className="w-full h-full object-cover"
        />
      </div>

      {/* Content Area with margins */}
      <div className="flex-1 flex flex-col px-[80px] pt-[96px] pb-[96px] z-10">
        {children}
      </div>

      {/* Pristine Progress Indicator */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-6">
        <div className="flex gap-2">
          {Array.from({ length: totalSlides }).map((_, i) => (
            <div 
              key={i}
              className="h-1.5 rounded-full transition-all duration-300"
              style={{ 
                width: i + 1 === slideNumber ? '40px' : '12px',
                backgroundColor: i + 1 === slideNumber ? COLORS.accentMagenta : COLORS.bgPattern
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

// Header Block Component
interface HeaderBlockProps {
  headline: string | React.ReactNode;
  subhead?: string;
  variant?: 'display' | 'title';
  gradientWords?: string[];
}

export const HeaderBlock: React.FC<HeaderBlockProps & { centered?: boolean, fontSize?: number, autoFit?: boolean, isCover?: boolean }> = ({ headline, subhead, variant = 'title', gradientWords = [], centered = false, fontSize, autoFit = false, isCover = false }) => {
  const isDisplay = variant === 'display';
  
  const renderHeadline = () => {
    if (typeof headline !== 'string') return headline;
    
    if (autoFit) {
      return <AutoFitText text={headline} />;
    }

    return headline;
  };

  return (
    <div className={`flex flex-col gap-[32px] mb-[64px] ${centered ? 'items-center text-center' : ''}`}>
      {isCover && (
        <div className="mb-4">
          <div className="w-[320px] h-[180px] flex items-center justify-center">
            <img 
              src={heartIcon} 
              alt="Hearts" 
              className="w-full h-full object-contain"
            />
          </div>
        </div>
      )}
      <h1 
        style={{
          fontSize: fontSize ? `${fontSize}px` : (isDisplay ? '110px' : '80px'),
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: '-0.04em',
          maxWidth: centered ? '1000px' : '920px',
          fontFamily: "'Space Grotesk', sans-serif",
          color: COLORS.textPrimary
        }}
      >
        {renderHeadline()}
      </h1>
      {subhead && (
        <div 
          className="mt-4 p-8 rounded-[20px] border border-white/50 backdrop-blur-xl"
          style={{
            backgroundColor: COLORS.glassBg,
            boxShadow: COLORS.glassShadow,
          }}
        >
          <p 
            style={{
              fontSize: '44px',
              fontWeight: 400,
              color: COLORS.textSecondary,
              lineHeight: 1.4,
              maxWidth: centered ? '900px' : '850px',
              fontFamily: "'Inter', sans-serif"
            }}
          >
            {subhead}
          </p>
        </div>
      )}
    </div>
  );
};

// Checklist Variant (Pristine Glassmorphism)
export const ChecklistLayout: React.FC<{ items: { lead: string; text: string }[], centered?: boolean }> = ({ items, centered = false }) => {
  return (
    <div className={`flex flex-col gap-[24px] mt-[32px] ${centered ? 'items-center text-center' : ''}`}>
      {items.map((item, i) => (
        <div 
          key={i} 
          className="p-8 rounded-[24px] border border-white/80 backdrop-blur-xl transition-all duration-300"
          style={{
            backgroundColor: COLORS.glassBg,
            boxShadow: COLORS.glassShadow,
          }}
        >
          <div className="flex flex-col gap-[12px]">
            <div className="flex items-center gap-4">
              <div className="w-4 h-4 rounded-full" style={{ background: `linear-gradient(135deg, ${COLORS.accentMagenta}, ${COLORS.accentCyan})` }} />
              <div style={{ fontSize: '42px', fontWeight: 700, color: COLORS.textPrimary, fontFamily: "'Space Grotesk', sans-serif" }}>
                {item.lead}
              </div>
            </div>
            <div style={{ fontSize: '36px', fontWeight: 400, color: COLORS.textSecondary, paddingLeft: '48px' }}>
              {item.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// Quote Variant
export const QuoteLayout: React.FC<{ quote: string; attribution: string, centered?: boolean }> = ({ quote, attribution, centered = false }) => {
  return (
    <div className={`flex-1 flex flex-col justify-center gap-[64px] ${centered ? 'items-center text-center' : ''}`}>
      <div 
        className="p-16 rounded-[32px] border border-white/80 backdrop-blur-2xl relative"
        style={{
          backgroundColor: COLORS.glassBg,
          boxShadow: '0 40px 100px -20px rgba(15, 23, 42, 0.08)',
        }}
      >
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-6 py-2 rounded-full border border-white bg-white/80 text-xl font-bold uppercase tracking-widest" style={{ color: COLORS.accentMagenta }}>
          Key Insight
        </div>
        <blockquote 
          style={{
            fontSize: '76px',
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
            fontFamily: "'Space Grotesk', sans-serif",
            color: COLORS.textPrimary
          }}
        >
          “{quote}”
        </blockquote>
      </div>
      <div 
        style={{
          fontSize: '32px',
          fontWeight: 600,
          color: COLORS.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: '0.15em',
          fontFamily: "'Inter', sans-serif"
        }}
      >
        — {attribution}
      </div>
    </div>
  );
};

// CTA Variant
export const CTALayout: React.FC<{ text: string }> = ({ text }) => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-[48px] text-center">
      <div 
        className="p-10 rounded-[40px] border border-white/80 backdrop-blur-2xl"
        style={{
          backgroundColor: COLORS.glassBg,
          boxShadow: '0 50px 100px -20px rgba(15, 23, 42, 0.1)',
        }}
      >
        <div style={{ width: '210px' }}>
          <ImageWithFallback 
            src={logoImg} 
            alt="Us.v2 Logo" 
            className="h-auto object-contain"
            style={{ width: '210px' }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-8">
        <p 
          style={{
            fontSize: '72px',
            fontWeight: 700,
            lineHeight: 1.1,
            maxWidth: '920px',
            color: COLORS.textPrimary,
            fontFamily: "'Space Grotesk', sans-serif",
          }}
        >
          Build the relationship you want.
        </p>
        <div className="flex flex-col gap-4 items-center">
          <p 
            style={{
              fontSize: '40px',
              fontWeight: 400,
              lineHeight: 1.4,
              maxWidth: '850px',
              color: COLORS.textSecondary
            }}
          >
            Get the 2026 Relationship Audit (Free)  —  Link in bio.
          </p>
          <div className="mt-8 flex justify-center">
            <div 
              className="px-12 py-5 rounded-2xl text-white text-3xl font-bold tracking-tight shadow-xl transition-transform hover:scale-105"
              style={{ 
                background: `linear-gradient(135deg, ${COLORS.accentMagenta}, ${COLORS.accentCyan})`,
                boxShadow: '0 20px 40px -10px rgba(255, 0, 127, 0.3)'
              }}
            >
          
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
