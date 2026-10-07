import { productName } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import { useId, useState, useSyncExternalStore } from 'react';
import { SiteNav } from '../auth/SiteNav';
import { FilterChips } from '../components/FilterChips';
import { Footer } from '../components/Footer';
import { getProjectsList, type ListedProject } from '../project/data';
import { filterProjects, PR_FILTERS, type PrFilter } from '../project/list';
import { ProjectRow } from '../project/ProjectRow';
import projectRowsCss from '../styles/project-rows.css?url';
import projectsCss from '../styles/projects-page.css?url';
import { routeHead } from '../readable/head';

// Every project asking for help (brand/brief-website.md), how it got in,
// and what it asks for, with a filter by PR mode and a search. The list is
// the homepage's projects asking for help, all of them. The filter and the
// search run in the page.
export const Route = createFileRoute('/projects')({
  loader: () => getProjectsList(),
  head: ({ matches }) =>
    routeHead(
      matches,
      {
        title: `Projects · ${productName}`,
        description: 'Every open source project that asked for agent help on Good First Token, on its own terms.',
        path: '/projects',
      },
      [
        { rel: 'stylesheet', href: projectRowsCss },
        { rel: 'stylesheet', href: projectsCss },
      ],
    ),
  component: Projects,
});

function Projects() {
  const list = Route.useLoaderData();
  return (
    <>
      <SiteNav current="projects" />
      <main className="wrap projects">
        <h1 className="display projects-title">
          Every one said yes
        </h1>
        {list.state === 'unavailable' ? (
          <p className="projects-note">The projects can&apos;t be read right now. Try again in a moment.</p>
        ) : list.projects.length === 0 ? (
          <p className="projects-note">No projects yet.</p>
        ) : (
          <ProjectList projects={list.projects} total={list.total} />
        )}
      </main>
      <Footer />
    </>
  );
}

const noChanges = () => () => undefined;

function count(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'project' : 'projects'}`;
}

function ProjectList({ projects, total }: { projects: ListedProject[]; total: number }) {
  const searchId = useId();
  const [filter, setFilter] = useState<PrFilter>('all');
  const [search, setSearch] = useState('');
  // The controls work once the page's script runs, so they are off in the
  // server's render, and on from the page's first render after it.
  const ready = useSyncExternalStore(noChanges, () => true, () => false);
  const shown = filterProjects(projects, filter, search);
  const filtered = filter !== 'all' || search.trim() !== '';

  return (
    <>
      <form
        className="projects-controls"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <fieldset disabled={!ready}>
          <legend className="visually-hidden">Filter the projects</legend>
          <FilterChips label="Filter by PR mode" options={PR_FILTERS} value={filter} onChange={setFilter} />
          <label className="visually-hidden" htmlFor={searchId}>
            Search projects
          </label>
          <input
            id={searchId}
            className="projects-search"
            type="search"
            placeholder="search"
            autoComplete="off"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </fieldset>
      </form>
      <p className="projects-count" role="status">
        {filtered ? `${shown.length.toLocaleString('en-US')} of ${count(projects.length)}` : count(total)}
      </p>
      {shown.length > 0 && (
        <ul className="project-rows projects-rows">
          {shown.map((project) => (
            <ProjectRow key={project.repo} project={project} />
          ))}
        </ul>
      )}
      {shown.length === 0 && (
        <p className="projects-note">
          Nothing matches. Maintainers add theirs from <a href="/maintainers">their agent</a>.
        </p>
      )}
      {total > projects.length && (
        <p className="projects-note">The first {count(projects.length)} of {total.toLocaleString('en-US')}.</p>
      )}
    </>
  );
}
