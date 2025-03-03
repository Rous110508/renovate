import is from '@sindresorhus/is';
import { load } from 'js-yaml';
import * as datasourceDocker from '../../datasource/docker';
import { GitTagsDatasource } from '../../datasource/git-tags';
import * as datasourceGitHubTags from '../../datasource/github-tags';
import { HelmDatasource } from '../../datasource/helm';
import { logger } from '../../logger';
import { SkipReason } from '../../types';
import { regEx } from '../../util/regex';
import { splitImageParts } from '../dockerfile/extract';
import type { PackageDependency, PackageFile } from '../types';
import type { HelmChart, Image, Kustomize } from './types';

// URL specifications should follow the hashicorp URL format
// https://github.com/hashicorp/go-getter#url-format
const gitUrl = regEx(
  /^(?:git::)?(?<url>(?:(?:(?:http|https|ssh):\/\/)?(?:.*@)?)?(?<path>(?:[^:/\s]+(?::[0-9]+)?[:/])?(?<project>[^/\s]+\/[^/\s]+)))(?<subdir>[^?\s]*)\?ref=(?<currentValue>.+)$/
);

export function extractResource(base: string): PackageDependency | null {
  const match = gitUrl.exec(base);

  if (!match) {
    return null;
  }

  const { path } = match.groups;
  if (path.startsWith('github.com:') || path.startsWith('github.com/')) {
    return {
      currentValue: match.groups.currentValue,
      datasource: datasourceGitHubTags.id,
      depName: match.groups.project.replace('.git', ''),
    };
  }

  return {
    datasource: GitTagsDatasource.id,
    depName: path.replace('.git', ''),
    lookupName: match.groups.url,
    currentValue: match.groups.currentValue,
  };
}

export function extractImage(image: Image): PackageDependency | null {
  if (!image.name) {
    return null;
  }
  const nameDep = splitImageParts(image.newName ?? image.name);
  const { depName } = nameDep;
  const { digest, newTag } = image;
  if (digest && newTag) {
    logger.warn(
      { newTag, digest },
      'Kustomize ignores newTag when digest is provided. Pick one, or use `newTag: tag@digest`'
    );
    return {
      depName,
      currentValue: newTag,
      currentDigest: digest,
      skipReason: SkipReason.InvalidDependencySpecification,
    };
  }

  if (digest) {
    if (!is.string(digest) || !digest.startsWith('sha256:')) {
      return {
        depName,
        currentValue: digest,
        skipReason: SkipReason.InvalidValue,
      };
    }

    return {
      datasource: datasourceDocker.id,
      depName,
      currentValue: nameDep.currentValue,
      currentDigest: digest,
      replaceString: digest,
    };
  }

  if (newTag) {
    if (!is.string(newTag) || newTag.startsWith('sha256:')) {
      return {
        depName,
        currentValue: newTag,
        skipReason: SkipReason.InvalidValue,
      };
    }

    const dep = splitImageParts(`${depName}:${newTag}`);
    return {
      ...dep,
      datasource: datasourceDocker.id,
      replaceString: newTag,
    };
  }

  if (image.newName) {
    return {
      ...nameDep,
      datasource: datasourceDocker.id,
      replaceString: image.newName,
    };
  }

  return null;
}

export function extractHelmChart(
  helmChart: HelmChart
): PackageDependency | null {
  if (!helmChart.name) {
    return null;
  }

  return {
    depName: helmChart.name,
    currentValue: helmChart.version,
    registryUrls: [helmChart.repo],
    datasource: HelmDatasource.id,
  };
}

export function parseKustomize(content: string): Kustomize | null {
  let pkg: Kustomize | null = null;
  try {
    pkg = load(content, { json: true }) as Kustomize;
  } catch (e) /* istanbul ignore next */ {
    return null;
  }

  if (!pkg) {
    return null;
  }

  if (!['Kustomization', 'Component'].includes(pkg.kind)) {
    return null;
  }

  return pkg;
}

export function extractPackageFile(content: string): PackageFile | null {
  logger.trace('kustomize.extractPackageFile()');
  const deps: PackageDependency[] = [];

  const pkg = parseKustomize(content);
  if (!pkg) {
    return null;
  }

  // grab the remote bases
  for (const base of pkg.bases ?? []) {
    const dep = extractResource(base);
    if (dep) {
      deps.push({
        ...dep,
        depType: pkg.kind,
      });
    }
  }

  // grab the remote resources
  for (const resource of pkg.resources ?? []) {
    const dep = extractResource(resource);
    if (dep) {
      deps.push({
        ...dep,
        depType: pkg.kind,
      });
    }
  }

  // grab the remote components
  for (const component of pkg.components ?? []) {
    const dep = extractResource(component);
    if (dep) {
      deps.push({
        ...dep,
        depType: pkg.kind,
      });
    }
  }

  // grab the image tags
  for (const image of pkg.images ?? []) {
    const dep = extractImage(image);
    if (dep) {
      deps.push({
        ...dep,
        depType: pkg.kind,
      });
    }
  }

  // grab the helm charts
  for (const helmChart of pkg.helmCharts ?? []) {
    const dep = extractHelmChart(helmChart);
    if (dep) {
      deps.push({
        ...dep,
        depType: 'HelmChart',
      });
    }
  }

  if (!deps.length) {
    return null;
  }
  return { deps };
}
