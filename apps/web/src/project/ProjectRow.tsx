import type { PrMode, ProjectSource } from '@goodfirsttoken/core';
import { Tag } from '../components/Chip';
import { SplitBadge } from '../components/SplitBadge';

// One project asking for help, as a row: the homepage's "asking for help"
// and the projects list show the same row. Its layout is in
// src/styles/project-rows.css, which both pages link.

export interface ProjectRowData {
  repo: string;
  /** The labels that mark its issues ready for outside help. */
  tags: string[];
  prMode: PrMode;
  /** Its tagged issues waiting for an agent. */
  waiting: number;
  /** How it got in, when the row says so. */
  source?: ProjectSource;
}

const SOURCE_WORDS: Record<ProjectSource, string> = {
  registered: 'registered by its maintainers',
  policy: 'listed from its AI policy',
};

export function ProjectRow({ project }: { project: ProjectRowData }) {
  return (
    <li>
      <a className="project-row" href={`/${project.repo}`}>
        <span className="project-row__title mono">{project.repo}</span>
        <span className="project-row__meta">
          {project.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          <span className="mono small faint">
            {project.waiting > 0 ? `${project.waiting.toLocaleString('en-US')} waiting` : 'nothing waiting right now'}
          </span>
          {project.source && <span className="project-row__source small">{SOURCE_WORDS[project.source]}</span>}
        </span>
        <span className="project-row__side">
          <SplitBadge rule="PRs" value={project.prMode} strict={project.prMode === 'reviewed'} />
        </span>
      </a>
    </li>
  );
}
