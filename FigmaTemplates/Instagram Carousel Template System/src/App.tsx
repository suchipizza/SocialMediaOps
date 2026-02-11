import React from 'react';
import { SlideBase, HeaderBlock, ChecklistLayout, QuoteLayout, CTALayout } from './components/slide-system';

const Slides = () => {
  return (
    <div className="min-h-screen bg-[#050505] flex flex-col items-center py-20 gap-32">
      {/* Introduction */}
      <div className="max-w-2xl px-8 text-center space-y-4">
        <h1 className="text-4xl font-bold text-white tracking-tight">Us.v2 Revised Template</h1>
        <p className="text-neutral-400 text-lg leading-relaxed">
          Centered Text • Large Cover Headline • Full Brand Logo
        </p>
      </div>

      {/* Slide Container */}
      <div className="flex flex-col gap-40 w-full max-w-[1200px] items-center px-4">
        
        {/* S1: Cover */}
        <SlideWrapper id="slide-1" label="S1 COVER">
          <SlideBase slideNumber={1}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                variant="display"
                headline="Relationship Foundations"
                subhead="The basics that prevent 80% of fights."
                autoFit
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S2: Hook */}
        <SlideWrapper id="slide-2" label="S2 HOOK">
          <SlideBase slideNumber={2}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="Healthy love is built, not found."
                subhead="The foundation is what you do on normal days."
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S3: Truth */}
        <SlideWrapper id="slide-3" label="S3 TRUTH">
          <SlideBase slideNumber={3}>
            <QuoteLayout 
              quote="Consistency beats intensity."
              attribution="Us.v2 principle"
              centered
            />
          </SlideBase>
        </SlideWrapper>

        {/* S4: Sign */}
        <SlideWrapper id="slide-4" label="S4 SIGN">
          <SlideBase slideNumber={4}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="3 signs your foundation is strong"
                centered
              />
              <ChecklistLayout 
                centered
                items={[
                  { lead: "Repair happens fast:", text: "conflicts end with reconnection." },
                  { lead: "Assumptions get checked:", text: "you ask, not guess." },
                  { lead: "Needs are allowed:", text: "no one has to earn basic care." }
                ]} 
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S5: Mistake */}
        <SlideWrapper id="slide-5" label="S5 MISTAKE">
          <SlideBase slideNumber={5}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="The #1 silent killer"
                subhead="Unspoken expectations turning into resentment."
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S6: Reframe */}
        <SlideWrapper id="slide-6" label="S6 REFRAME">
          <SlideBase slideNumber={6}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="Try this reframe"
                subhead="From ‘You should know’ → ‘Here’s what helps me.’"
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S7: Micro-Rule */}
        <SlideWrapper id="slide-7" label="S7 MICRO-RULE">
          <SlideBase slideNumber={7}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="One rule for every couple"
                subhead="Talk about problems as ‘Us vs the issue.’"
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S8: Example */}
        <SlideWrapper id="slide-8" label="S8 EXAMPLE">
          <SlideBase slideNumber={8}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="Example script"
                subhead="‘Can we solve this together? I’m on your team, and I need ___.’"
                centered
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S9: Action */}
        <SlideWrapper id="slide-9" label="S9 ACTION">
          <SlideBase slideNumber={9}>
            <div className="flex-1 flex flex-col justify-center items-center text-center">
              <HeaderBlock 
                headline="This week’s foundation habit"
                centered
              />
              <ChecklistLayout 
                centered
                items={[
                  { lead: "Daily check-in:", text: "2 minutes, no fixing." },
                  { lead: "Appreciation:", text: "1 specific thing you noticed." },
                  { lead: "Clarity:", text: "1 expectation said out loud." }
                ]} 
              />
            </div>
          </SlideBase>
        </SlideWrapper>

        {/* S10: CTA */}
        <SlideWrapper id="slide-10" label="S10 CTA">
          <SlideBase slideNumber={10}>
            <CTALayout 
              text="Build the relationship you want. First 250 get early access to Us.v2 app — join via link in bio."
            />
          </SlideBase>
        </SlideWrapper>

      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
      ` }} />
    </div>
  );
};

const SlideWrapper = ({ children, id, label }: { children: React.ReactNode, id: string, label: string }) => {
  return (
    <div id={id} className="group flex flex-col items-center gap-6 w-full max-w-full overflow-hidden">
      <div className="flex items-center gap-4 w-full max-w-[810px]">
        <div className="h-px flex-1 bg-white/10" />
        <span className="text-[10px] font-bold tracking-[0.2em] text-neutral-500 uppercase">{label}</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>
      <div className="relative shadow-2xl shadow-black/50 transition-transform duration-500 group-hover:scale-[1.01] overflow-hidden rounded-xl bg-black">
        <div className="w-[320px] h-[400px] sm:w-[432px] sm:h-[540px] md:w-[648px] md:h-[810px] lg:w-[810px] lg:h-[1012.5px] relative">
          <div className="absolute top-0 left-0 origin-top-left scale-[0.296] sm:scale-[0.4] md:scale-[0.6] lg:scale-[0.75] w-[1080px] h-[1350px]">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Slides;
