const { Op } = require('sequelize')
const { getQueryAndFlagInfo, bibleSearch, BIBLE_SEARCH_FLAG_MAP } = require('@bibletags/bibletags-ui-helper')

const bibleSearchResults = async (args, req, queryInfo) => {

let a = Date.now()
  const { query, flags } = getQueryAndFlagInfo({ ...args, FLAG_MAP: BIBLE_SEARCH_FLAG_MAP })

  const { models } = global.connection

  if(/(?:^| )[^#= ]/.test(query.replace(/["/()*.]/g, ''))) throw `invalid original language search: contains token that doesn't start with # or =`

  if(!(flags.in || []).some(inItem => [ 'uhb', 'ugnt', 'lxx' ].includes(inItem))) {
    flags.in = flags.in || []
    if(/#G/.test(query)) {
      flags.in.push('ugnt')
    } else if(/#H/.test(query)) {
      flags.in.push('uhb')
    } else {
      flags.in.push('ugnt')
      flags.in.push('uhb')
    }
  }

  const getVersions = async versionIds => versionIds.map(versionId => ({
    id: versionId,
    versificationModel: 'original',
    // NOTE: I haven't yet decided if the LXX will use its native versification or if I will convert it to original versification.
    // If I do the former, then I will need its proper information returned here.
  }))

  const getUnitWords = async ({ versionId, id, limit }) => (
    await models[`${versionId}UnitWord`].findAll({
      where: {
        id: (
          /^[^*]+\*$/.test(id)
            ? {
              [Op.like]: global.connection.literal(`"${id.replace(/([%_\\"])/g, '\\$1').replace(/\*/g, '%')}" ESCAPE '\\\\'`),
            }
            : id
        )
      },
      limit,
    })
  )

  const getUnitRanges = async ({ versionId, ids }) => (
    await models[`${versionId}UnitRange`].findAll({
      where: {
        id: ids,
      },
    })
  )

  const getVerses = async ({ versionId, locs }) => (
    await models[`${versionId}Verse`].findAll({
      where: {
        loc: locs,
      },
    })
  )

  return bibleSearch({
    ...args,
    query,
    flags,
    getVersions,
    getUnitWords,
    getUnitRanges,
    getVerses,
    // doClocking: true,
  })

}

module.exports = bibleSearchResults