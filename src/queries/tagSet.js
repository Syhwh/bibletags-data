const {
  locRegEx,
  versionIdRegEx,
  wordsHashRegEx,
} = require('../constants')

const tagSet = async (args, req, queryInfo) => {

  const { id } = args
  const [ loc, versionId, wordsHash, invalidExtra ] = id.split('-')

  if(wordsHash === undefined || invalidExtra !== undefined) {
    throw `Invalid id (${id}).`
  }

  if(!loc.match(locRegEx)) {
    throw `Invalid loc (${loc}) indicated in id (${id}).`
  }

  if(!versionId.match(versionIdRegEx)) {
    throw `Invalid versionId (${versionId}) indicated in id (${id}).`
  }

  if(!wordsHash.match(wordsHashRegEx)) {
    throw `Invalid wordsHash (${wordsHash}) indicated in id (${id}).`
  }

  const { models } = global.connection

  const where = {
    loc,
    versionId,
    wordsHash,
  }

  const tagSet = await models.tagSet.findOne({
    where,
  })

  return {
    id,
    tags: tagSet ? tagSet.tags : [],
    status: tagSet ? tagSet.status : 'none',
  }

}

module.exports = tagSet