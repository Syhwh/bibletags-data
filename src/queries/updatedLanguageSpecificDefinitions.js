const {
  languageIdRegEx,
} = require('../constants')

const updatedLanguageSpecificDefinitions = async (args, req, queryInfo) => {

  const { languageId, updatedFrom } = args

  if(!languageId.match(languageIdRegEx)) {
    throw `Invalid languageId (${languageId}).`
  }

  const { models } = global.connection

  const limit = 100

  let languageSpecificDefinitions = await models.languageSpecificDefinition.findAll({
    where: {
      updatedAt: {
        [Op.gte]: updatedFrom,
      },
      languageId,
    },
    order: [ 'updatedAt' ],
    limit,
  })

  const newUpdatedFrom = languageSpecificDefinitions.slice(-1)[0].updatedAt

  if(languageSpecificDefinitions.length === limit) {
    // prevent situation where multiple sets with the same timestamp are split between results
    languageSpecificDefinitions = [
      ...languageSpecificDefinitions.filter(({ updatedAt }) => updatedAt !== newUpdatedFrom),
      ...(await models.tagSet.findAll({
        where: {
          updatedAt: updatedFrom,
          languageId,
        },
      })),
    ]
  }

  languageSpecificDefinitions = languageSpecificDefinitions.map(({ definitionId, gloss, syn, rel, lexEntry, editorId }) => ({
    id: `${definitionId}-${languageId}`,
    gloss,
    syn,
    rel,
    lexEntry,
    editorId,
  }))

  return {
    languageSpecificDefinitions,
    hasMore: languageSpecificDefinitions.length >= limit,
    newUpdatedFrom,
  }

}

module.exports = updatedLanguageSpecificDefinitions