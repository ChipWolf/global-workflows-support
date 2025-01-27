const { copy } = require('fs-extra');
const { readdir } = require('fs').promises;
const path = require('path');
const core = require('@actions/core');
const { getCommitFiles } = require('./api-calls');

module.exports = { copyChangedFiles, parseCommaList, getListOfReposToIgnore, getBranchName, getListOfFilesToReplicate, getAuthanticatedUrl, isInit };

/**
 * @param  {Object} octokit GitHub API client instance
 * @param  {Object} commitId Id of the commit to check for files changes
 * @param  {String} owner org or user name
 * @param  {String} repo repo name
 * @param  {String} filesToIgnore comma-separated list of files that should be ignored
 * @param  {String} filesToInclude comma-seperated list of files which should be included
 * @param  {String} triggerEventName name of the event that triggered the workflow
 * 
 * @returns {Array<String>} list of filepaths of modified files
 */
async function getListOfFilesToReplicate(octokit, commitId, owner, repo, filesToIgnore, filesToInclude, triggerEventName) {
  let filesToCheckForReplication;
  const defaultWorkflowsDir = '.github/workflows';

  if (triggerEventName === 'push') {
    const commitFiles = await getCommitFiles(octokit, commitId, owner, repo);
    filesToCheckForReplication = commitFiles.map((el) => el.filename);
    core.debug(`DEBUG: list of commited files for commit ${commitId} that is used to check if there was any file located in .github/workflows modified: ${filesToCheckForReplication}`);
  }

  if (triggerEventName === 'workflow_dispatch') {
    const workspaceDirPath = path.join(process.cwd());
    const workspaceDirFilesList = await getAllFiles(workspaceDirPath);
    filesToCheckForReplication = workspaceDirFilesList.map(filename => path.join(filename.replace(workspaceDirPath, '').substring(1)));
    core.debug(`DEBUG: list of files from ${workspaceDirPath} directory is ${filesToCheckForReplication}`);
  }

  const changedFiles = [];
  const ignoreFilesList = filesToIgnore ? parseCommaList(filesToIgnore) : [];
  const includeFilesList = filesToInclude ? parseCommaList(filesToInclude) : [];
  
  core.info(`List of files that should be ignored: ${ignoreFilesList}`);
  core.info(`List of files that should be included: ${includeFilesList}`);

  for (const filename of filesToCheckForReplication) {
    const onlyFileName = filename.split('/').slice(-1)[0];
    const isFileIgnored = !!ignoreFilesList.map(file => file === onlyFileName).filter(Boolean).length;
    const isFileIncluded = !!includeFilesList.map(file => file === filename).filter(Boolean).length;
    const isWorkflowFile = filename.includes(defaultWorkflowsDir);
    core.info(`Checking if ${filename} is located in workflows directory (${isWorkflowFile}) or is included (${isFileIncluded}) and if ${onlyFileName} should be ignored (${isFileIgnored})`);

    if ((isWorkflowFile || isFileIncluded) && !isFileIgnored) {
      changedFiles.push(filename);
    }
  }

  return changedFiles;
}

/**
 * Assemble a list of repositories that should be ignored.
 * 
 * @param  {String} repo The current repository.
 * @param  {Array} reposList All the repositories.
 * @param  {String} inputs.reposToIgnore A comma separated list of repositories to ignore.
 * @param  {String} inputs.topicsToInclude A comma separated list of topics to include.
 * @param  {Boolean} inputs.excludeForked Exclude forked repositories.
 * @param  {Boolean} inputs.excludePrivate Exclude private repositories.
 * 
 * @returns  {Array}
 */
function getListOfReposToIgnore(repo, reposList, inputs) {
  const {
    reposToIgnore,
    topicsToInclude,
    excludeForked,
    excludePrivate,
  } = inputs;

  //manually ignored repositories.
  const ignoredRepositories = reposToIgnore ? parseCommaList(reposToIgnore) : [];

  // Exclude archived repositories by default. The action will fail otherwise.
  const EXCLUDE_ARCHIVED = true;
  if (EXCLUDE_ARCHIVED === true) {
    ignoredRepositories.push(...archivedRepositories(reposList));
  }

  //by default repo where workflow runs should always be ignored.
  ignoredRepositories.push(repo);

  // if topics_to_ignore is set, get ignored repositories by topics.
  if (topicsToInclude.length) {
    ignoredRepositories.push(...ignoredByTopics(topicsToInclude, reposList));
  }

  // Exclude forked repositories
  if (excludeForked === true) {
    ignoredRepositories.push(...forkedRepositories(reposList));
  }

  // Exclude private repositories.
  if (excludePrivate === true) {
    ignoredRepositories.push(...privateRepositories(reposList));
  }

  return ignoredRepositories;
}

/**
 * @param  {Array} filesList list of files that need to be copied
 * @param  {String} destination where file should be copied
 */
async function copyChangedFiles(filesList, destination) {
  await Promise.all(filesList.map(async filepath => {
    return await copy(path.join(process.cwd(), filepath), path.join(destination, filepath));
  }));
}

/**
 * @param  {String} list names of values that can be separated by comma
 * @returns  {Array<String>} input names not separated by string but as separate array items
 */
function parseCommaList(list) {
  return list.split(',').map(i => i.trim().replace(/['"]+/g, ''));
}

/**
 * Create a branch name. 
 * If commitId is not provided then it means action was not triggered by push and name must have some generated number and indicate manual run
 * 
 * @param  {String} commitId id of commit that should be added to branch name for better debugging of changes
 * @returns  {String}
 */
function getBranchName(commitId) {
  return commitId ? `bot/update-global-workflow-${commitId}` : `bot/manual-update-global-workflow-${Math.random().toString(36).substring(7)}`;
}

/**
 * Creates a url with authentication token in it
 * 
 * @param  {String} token access token to GitHub
 * @param  {String} url repo URL
 * @returns  {String}
 */
function getAuthanticatedUrl(token, url) {
  const arr = url.split('//');
  return `https://${token}@${arr[arr.length - 1]}.git`;
};

/**
 * Checking if repo is initialized cause if it isn't we need to ignore it
 * 
 * @param  {Array<Object>} branches list of all local branches with detail info about them
 * @param  {String} defaultBranch name of default branch that is always set even if repo not initialized
 * @returns  {Boolean}
 */
function isInit(branches, defaultBranch) {
  core.debug(`DEBUG: list of local branches: ${branches.branches}`);
  return !!branches.branches[defaultBranch];
}

/**
 * Getting list of topics that should be included if topics_to_include is set.
 * Further on we will get a list of repositories that do not belong to any of the specified topics.
 * 
 * @param  {String} topicsToInclude Comma separated list of topics to include.
 * @param  {Array} reposList All the repositories.
 * @returns {Array} List of all repositories to exclude.
 */
function ignoredByTopics(topicsToInclude, reposList) {
  const includedTopics = topicsToInclude ? parseCommaList(topicsToInclude) : [];

  if (!includedTopics.length) return;

  return reposList.filter(repo => {
    return includedTopics.some(topic => repo.topics.includes(topic)) === false;
  }).map(reposList => reposList.name);
}

/**
 * Returns a list of archived repositories.
 * 
 * @param  {Array} reposList All the repositories.
 * @returns {Array}
 */
function archivedRepositories(reposList) {
  return reposList.filter(repo => {
    return repo.archived === true;
  }).map(reposList => reposList.name);
}

/**
 * Returns a list of private repositories.
 * 
 * @param  {Array} reposList All the repositories.
 * @returns {Array}
 */
function privateRepositories(reposList) {
  return reposList.filter(repo => {
    return repo.private === true;
  }).map(reposList => reposList.name);
}

/**
 * Returns a list of forked repositories.
 * 
 * @param  {Array} reposList All the repositories.
 * @returns {Array}
 */
function forkedRepositories(reposList) {
  return reposList.filter(repo => {
    return repo.fork === true;
  }).map(reposList => reposList.name);
}

/**
 * Returns a list of files recursively from a given directory
 *
 * @param   {String} dir Directory to scan recursively for files
 * @returns {Array}
 */
async function getAllFiles(dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(dirents.map((dirent) => {
    const res = path.resolve(dir, dirent.name);
    return dirent.isDirectory() ? getAllFiles(res) : res;
  }));
  return files.flat();
}
