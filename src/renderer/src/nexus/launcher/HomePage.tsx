import { IslandStage } from './IslandStage';
import { RecentProjects } from './RecentProjects';

export function HomePage() {
  return (
    <div className="nx-home">
      <header className="nx-home__head">
        <h1 tabIndex={-1} className="nx-home__title">What are you <span className="nx-grad">working on?</span></h1>
        <p className="nx-home__sub">Choose a workspace and start building with your agents.</p>
      </header>
      <IslandStage />
      <RecentProjects />
    </div>
  );
}
