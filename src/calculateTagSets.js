const { hash64 } = require('@bibletags/bibletags-ui-helper')

const { getOrigLangVersionIdFromLoc, equalObjs, getObjFromArrayOfObjs, deepSortTagSetTags, cloneObj } = require('./utils')
const getWordInfoByIdAndPart = require('./getWordInfoByIdAndPart')

const SUBMIT_TAG_SETS_CALC_ROW_LIMIT_PER_STATUS = 100
const WORD_HASHES_SUBMISSIONS_CALC_ROW_LIMIT = 100

const calculateTagSets = async ({
  loc,
  versionId,
  wordsHash,
  justSubmittedUserId,
  currentTagSet,
  t,
}) => {

  loc = loc || (currentTagSet || {}).loc
  versionId = versionId || (currentTagSet || {}).versionId
  wordsHash = wordsHash || (currentTagSet || {}).wordsHash

  const { models } = global.connection

  const autoMatchTagSetUpdatesByUniqueKey = {}
  const origLangVersionId = getOrigLangVersionIdFromLoc(loc)
  const wordInfoByIdAndPartByVersionAndLoc = {}

  const [ baseVersion, tagSetSubmissions, tagSet=currentTagSet ] = await Promise.all([

    models.version.findByPk(versionId, {transaction: t}),

    models.tagSetSubmission.findAll({
      where: {
        loc,
        versionId,
        wordsHash,
      },
      include: [
        {
          model: models.user,
          attributes: [ 'id', 'rating' ],
          required: true,
        },
        {
          model: models.tagSetSubmissionItem,
          required: true,
          include: [
            {
              model: models.tagSetSubmissionItemTranslationWord,
              required: false,
            },
            {
              model: models[`${origLangVersionId}TagSubmission`],
              required: false,
            },
          ],
        },
      ],
      order: [[ 'createdAt', 'DESC' ]],
      transaction: t,
    }),

    ...(currentTagSet ? [] : [
      models.tagSet.findOne({
        where: {
          loc,
          versionId,
          wordsHash,
        },
        transaction: t,
      }),
    ]),

  ])

  const { languageId } = baseVersion

  const getTagsJson = ({ tagSetSubmissionItems }) => (
    tagSetSubmissionItems.map(tagSetSubmissionItem => ({
      o: (
        tagSetSubmissionItem[`${origLangVersionId}TagSubmissions`]
          .map(tag => `${tag[`${origLangVersionId}WordId`]}${origLangVersionId === 'uhb' ? `|${tag.wordPartNumber}` : ``}`)
      ),
      t: (
        tagSetSubmissionItem.tagSetSubmissionItemTranslationWords
          .map(({ wordNumberInVerse }) => wordNumberInVerse)
      ),
    }))
  )

  const getBaseAutoMatchTagInfo = async () => {

    const [ versionsById, baseWordInfoByIdAndPart, wordHashesSetSubmission ] = await Promise.all([

      (async () => {
        const versions = await models.version.findAll({
          where: {
            languageId,
          },
          transaction: t,
        })
        return getObjFromArrayOfObjs(versions)
      })(),

      getWordInfoByIdAndPart({ version: baseVersion, loc, t }),

      models.wordHashesSetSubmission.findOne({
        where: {
          loc,
          versionId,
          wordsHash,
        },
        include: [
          {
            model: models.wordHashesSubmission,
            required: false,
          },
        ],
        order: [[ models.wordHashesSubmission, 'wordNumberInVerse' ]],
        transaction: t,
      }),

    ])

    return {
      versionsById,
      baseWordInfoByIdAndPart,
      baseWordHashesSubmissions: wordHashesSetSubmission.wordHashesSubmissions,
    }
  }

  const getAutoMatchTags = async ({
    baseWordInfoByIdAndPart,
    baseWordHashesSubmissions,
    baseWordNumberInVerse,
    baseTag,
    newTagSetRating=0,
    wordHashesSetSubmissions,
    wordInfoSetByKey,
  }) => {

    const startFromTag = !!baseTag

    const fixedUniqueKey = startFromTag ? `` : `${loc} ${versionId} ${wordsHash}`
    if(!startFromTag && !autoMatchTagSetUpdatesByUniqueKey[fixedUniqueKey]) {
      autoMatchTagSetUpdatesByUniqueKey[fixedUniqueKey] = (
        currentTagSet
          ? cloneObj(currentTagSet)
          : {
            tags: [],
            autoMatchScores: [],
            status: 'none',
            hasChange: true,
            loc,
            versionId,
            wordsHash,
          }
      )
      delete autoMatchTagSetUpdatesByUniqueKey[fixedUniqueKey].createdAt
    }

    // for each wordHashesSetSubmissions
    wordHashesSetSubmissions.forEach(wordHashesSetSubmission => {

      const {

        loc,
        versionId,
        wordsHash,
        tagSetId,

        // following relevant for new tag submission call only
        wordHashesSubmissions=[],
        autoMatchScores=[],
        numTranslationWords,

        // following relevant for new word hashes submission only
        wordNumberInVerse,
        withBeforeHash,
        withAfterHash,
        withBeforeAndAfterHash,

      } = wordHashesSetSubmission

      const tags = JSON.parse(wordHashesSetSubmission.tags || `[]`)
      const tag = baseTag || tags.find(tag => tag.t.includes(wordNumberInVerse))

      if(tag.o.length === 0 || tag.t.length === 0) return

      let wordHashesSubmissionsArray
      if(startFromTag) {
        wordHashesSubmissionsArray = Object.values(wordHashesSubmissions)
      } else if(tag.t.length === 1) {
        wordHashesSubmissionsArray = [{
          withBeforeHash,
          withAfterHash,
          withBeforeAndAfterHash,
        }]
      } else {
        return
        // TODO: to be able to get multi-translation-word tags upon word hash submission, I need to 
        // add in code here to (1) get the hashes of the other words in the found tag, (2) look 
        // in the versionId/loc/wordsHash spot to see if we have all those words, (3) form the array,
        // including wordNumberInVerse for forming newTag.t below.
      }

      const thisRowWordInfoByIdAndPart = wordInfoSetByKey[`${loc}-${versionId}`]
      const tagWordInfoByIdAndPart = startFromTag ? baseWordInfoByIdAndPart : thisRowWordInfoByIdAndPart
      const searchWordInfoByIdAndPart = startFromTag ? thisRowWordInfoByIdAndPart : baseWordInfoByIdAndPart
      const searchRowWordInfos = Object.values(searchWordInfoByIdAndPart)

      const extraWordPartsBetweenEachOriginalWord = tag.o.slice(1).map((wordIdAndPartNumber, idx) => tagWordInfoByIdAndPart[wordIdAndPartNumber].wordPartNumberInVerse - tagWordInfoByIdAndPart[tag.o[idx]].wordPartNumberInVerse)
      const extraWordsBetweenEachTranslationWord = tag.t.slice(1).map((wordNumberInVerse, idx) => wordNumberInVerse - tag.t[idx])

      // check that this loc has all the definitionIds (or relevant word part)
      const getOrigMatchOptions = (currentMatchOption, remainingO) => {

        const [ wordIdAndPart, ...leftOverO ] = remainingO
        const { strongPart, morphPart } = tagWordInfoByIdAndPart[wordIdAndPart]
        const updatedMatchOptions = []

        searchRowWordInfos.forEach(wordInfo => {
          if(wordInfo.strongPart === strongPart) {

            const matchOptionWord = {
              wordIdAndPartNumber: wordInfo.wordIdAndPartNumber,
              scoreAddition: 0,
              wordPartNumberInVerse: wordInfo.wordPartNumberInVerse,
            }

            // add to auto-match score if same morph
            if(wordInfo.morphPart === morphPart) {
              matchOptionWord.scoreAddition += 1000000
            }

            updatedMatchOptions.push([
              ...currentMatchOption,
              matchOptionWord,
            ])

          }
        })

        if(leftOverO.length > 0) {
          return (
            updatedMatchOptions
              .map(option => getOrigMatchOptions(option, leftOverO))
              .flat()
          )
        } else {
          return updatedMatchOptions
        }
      }

      const origMatchOptions = getOrigMatchOptions([], tag.o)

      if(origMatchOptions.length === 0) return

      const newTag = {}
      let newAutoMatchScore = newTagSetRating

      // form newTag.t
      newTag.t = startFromTag ? wordHashesSubmissionsArray.map(({ wordNumberInVerse }) => wordNumberInVerse) : [ baseWordNumberInVerse ]
      
      // add to auto-match score and select best match
      const totalTranslationWordsInVerse = startFromTag ? numTranslationWords : baseWordHashesSubmissions.length
      const totalOrigWordsInVerse = searchRowWordInfos.length
      const bestMatchOptionInfo = { totalScoreAddition: -1 }
      const translationWordsPlacementPercentage = newTag.t.reduce((total,item) => total + item/totalTranslationWordsInVerse, 0) / newTag.t.length
      origMatchOptions.forEach(origMatchOption => {
        const extraWordPartsBetween = origMatchOption.slice(1).map(({ wordPartNumberInVerse }, idx) => wordPartNumberInVerse - origMatchOption[idx].wordPartNumberInVerse)
        let totalScoreAddition = origMatchOption.reduce((a,b) => a + b.scoreAddition, 0)
        if(equalObjs(extraWordPartsBetweenEachOriginalWord, extraWordPartsBetween)) {
          totalScoreAddition += 300000
        }
        const origWordsPlacementPercentage = origMatchOption.reduce((total, { wordPartNumberInVerse }) => total + wordPartNumberInVerse/totalOrigWordsInVerse, 0) / origMatchOption.length
        const differenceInWordPlacementPercentage = Math.abs(origWordsPlacementPercentage - translationWordsPlacementPercentage)
        totalScoreAddition += parseInt(2500 / Math.max(.01, differenceInWordPlacementPercentage) - 2500, 10)  // will yield between 0-247500
        if(totalScoreAddition > bestMatchOptionInfo.totalScoreAddition) {
          bestMatchOptionInfo.totalScoreAddition = totalScoreAddition
          bestMatchOptionInfo.wordIdAndPartNumbers = origMatchOption.map(({ wordIdAndPartNumber }) => wordIdAndPartNumber)
        }
      })

      // form newTag.o
      newTag.o = bestMatchOptionInfo.wordIdAndPartNumbers
      newAutoMatchScore += bestMatchOptionInfo.totalScoreAddition

      // add to auto-match score for exact translation word number progression
      const extraEntriesBetweenEachWordHash = wordHashesSubmissionsArray.slice(1).map(({ wordNumberInVerse }, idx) => (
        wordNumberInVerse - wordHashesSubmissionsArray[idx].wordNumberInVerse
      ))
      if(equalObjs(extraWordsBetweenEachTranslationWord, extraEntriesBetweenEachWordHash)) {
        newAutoMatchScore += 300000
      }

      // add to auto-match score for expansive match to hash
      const matchesHash = hashType => (
        tag.t.every(wordNumberInVerse => (
          wordHashesSubmissionsArray.some(wordHashesSubmission => (
            baseWordHashesSubmissions[(baseWordNumberInVerse || wordNumberInVerse) - 1][hashType] === wordHashesSubmission[hashType]
          ))
        ))
      )
      if(matchesHash(`withBeforeAndAfterHash`)) {
        newAutoMatchScore += 200000
      } else if(matchesHash(`withBeforeHash`) || matchesHash(`withAfterHash`)) {
        newAutoMatchScore += 100000
      }

      // make sure loc/versionId/wordsHash entry exists in tag updates
      const uniqueKey = fixedUniqueKey || `${loc} ${versionId} ${wordsHash}`
      let autoMatchTagSetUpdates = autoMatchTagSetUpdatesByUniqueKey[uniqueKey]
      if(!autoMatchTagSetUpdates) {
        autoMatchTagSetUpdates = autoMatchTagSetUpdatesByUniqueKey[uniqueKey] = {
          id: tagSetId,  // will be null if !startFromTag
          tags,
          autoMatchScores,
          status: tags.length > 0 ? 'automatch' : 'none',
          hasChange: false,
          loc,
          wordsHash,
          versionId,
        }
      }

      // if new tag has a better auto-match score than any conflicting, then set to replace these tags with the new (also updating the score)
      let bestScoreOfConflicting = 0
      const indexesOfConflictingTags = (
        autoMatchTagSetUpdates.tags
          .map((tag, idx) => {
            if(
              tag.o.some(wordIdAndPartNumber => newTag.o.includes(wordIdAndPartNumber))
              || tag.t.some(wordNumberInVerse => newTag.t.includes(wordNumberInVerse))
            ) {
              bestScoreOfConflicting = Math.max(bestScoreOfConflicting, autoMatchTagSetUpdates.autoMatchScores[idx])
              return idx
            }
            return null
          })
          .filter(v => v !== null)
      )
      if(newAutoMatchScore > bestScoreOfConflicting) {
        autoMatchTagSetUpdates.tags = autoMatchTagSetUpdates.tags.filter((x, idx) => !indexesOfConflictingTags.includes(idx))
        autoMatchTagSetUpdates.autoMatchScores = autoMatchTagSetUpdates.autoMatchScores.filter((x, idx) => !indexesOfConflictingTags.includes(idx))
        autoMatchTagSetUpdates.tags.push(newTag)
        deepSortTagSetTags(autoMatchTagSetUpdates.tags)
        autoMatchTagSetUpdates.autoMatchScores.splice(autoMatchTagSetUpdates.tags.indexOf(newTag), 0, newAutoMatchScore)
        autoMatchTagSetUpdates.status = 'automatch'
        autoMatchTagSetUpdates.hasChange = true
      }

    })

  }

  const updateAutoMatchTags = async () => {

    // destroy tags to be superseded
    const tagSetUpdates = Object.values(autoMatchTagSetUpdatesByUniqueKey).filter(({ hasChange }) => hasChange).map(({ hasChange, ...otherValues }) => otherValues)
    const tagSetDeleteIds = tagSetUpdates.map(({ id }) => id).filter(Boolean)
    if(tagSetDeleteIds.length > 0) {
      await models.tagSet.destroy({
        where: {
          id: tagSetDeleteIds,
        },
        transaction: t,
      })
    }

    // create new auto-match tags
    await models.tagSet.bulkCreate(
      tagSetUpdates.map(({ id, ...input }) => input),
      {
        validate: true,
        transaction: t,
      },
    )

  }

  if(tagSetSubmissions.length > 0) {  // coming from submitTagSet: update tagSet based on all submissions

    if(!tagSet) throw `Call to submitTagSet cannot proceed call to submitWordHashesSet: ${loc} / ${wordsHash}`

    // each tag gets a rating
    const tagsByTagStr = {}
    const tagsByUserId = {}
    const wordByNumberInVerse = []
    tagSetSubmissions.forEach(tagSetSubmission => {

      if(wordByNumberInVerse.length === 0) {
        tagSetSubmission.tagSetSubmissionItems.forEach(({ tagSetSubmissionItemTranslationWords }) => {
          tagSetSubmissionItemTranslationWords.forEach(({ word, wordNumberInVerse }) => {
            wordByNumberInVerse[wordNumberInVerse] = word
          })
        })
      }

      const tags = getTagsJson(tagSetSubmission)
      const { rating } = tagSetSubmission.user
      tagsByUserId[tagSetSubmission.user.id] = cloneObj(tags)
      if(rating < 2) return  // folks with ratings < 2 (they get more wrong than right!) are discounted

      tags.forEach(tag => {
        const tagAsStr = JSON.stringify(tag)
        if(tagsByTagStr[tagAsStr]) {
          tagsByTagStr[tagAsStr].rating *= rating
          tagsByTagStr[tagAsStr].numberOrAffirmations++
        } else {
          tagsByTagStr[tagAsStr] = {
            rating,
            numberOrAffirmations: 1,
            tag,
          }
        }
      })
    })

    // select tags, starting from best rating, so long as they are not duplicates
    let confirmed = true
    const newTagSetTags = []
    const newTagSetRatings = []
    const usedWords = {}
    const tagsOrderedByRating = Object.values(tagsByTagStr).sort((a,b) => a.rating < b.rating ? 1 : -1)
    tagsOrderedByRating.forEach(({ rating, numberOrAffirmations, tag }) => {
      const words = [ ...tag.o, ...tag.t ]
      if(!words.some(w => usedWords[w])) {
        newTagSetTags.push(tag)
        newTagSetRatings.push(Math.min(rating, 9999))
        words.forEach(w => {
          usedWords[w] = true
        })
        confirmed = (
          confirmed
          && numberOrAffirmations - (tagSetSubmissions.length - numberOrAffirmations) >= 2  // at least 2 more have chosen this than an alternative
          && rating >= 50
        )
      }
    })
    const newStatus = confirmed ? 'confirmed' : 'unconfirmed'
    deepSortTagSetTags(newTagSetTags)

    if(tagSet.status !== newStatus && (tagSet.status === `confirmed` || newStatus === `confirmed`)) {
      // update user ratings if status is changing
      await Promise.all(Object.keys(tagsByUserId).map(async userId => {
        deepSortTagSetTags(tagsByUserId[userId])
        const changeAmt = (
          newStatus === 'confirmed'
            ? equalObjs(tagsByUserId[userId], newTagSetTags) ? 1 : -1  // if now confirmed, reward and penalize
            : equalObjs(tagsByUserId[userId], tagSet.tags) ? -1 : 1  // if being reverted to unconfirmed, remove those rewards/penalties
        )
        if(newStatus === 'unconfirmed' && userId === justSubmittedUserId) return  // no rewards/penalties to revert
        const ratingHistoryAddition = `\n${changeAmt >= 0 ? `+`: ``}${changeAmt} (${loc} ${versionId.toUpperCase()} ${newStatus} ${new Date().toDateString().replace(/^[^ ]+ /, '')})`
        await models.user.update(
          {
            ratingHistory: global.connection.fn(`CONCAT`, global.connection.col(`ratingHistory`), ratingHistoryAddition),
            rating: global.connection.literal(`\`rating\` + ${changeAmt}`) ,
          },
          {
            where: {
              id: userId,
            },
            transaction: t,
          },
        )
      }))
    }

    if(equalObjs(newTagSetTags, tagSet.tags)) {

      if(tagSet.status !== newStatus) {
        tagSet.status = newStatus
        tagSet.set('createdAt', new Date(), { raw: true })
        await tagSet.save({ transaction: t, fields: [ 'status', 'createdAt' ] })
      }

    } else {

      // create the new tagSet based on submissions

      if(tagSet) {
        await tagSet.destroy({transaction: t})  // will cascade
      }

      await models.tagSet.create({
        loc,
        tags: newTagSetTags,
        status: newStatus,
        wordsHash,
        versionId,
      }, {transaction: t})

      // attempt to create auto-match tags

      const { versionsById, baseWordInfoByIdAndPart, baseWordHashesSubmissions } = await getBaseAutoMatchTagInfo()

      // combining as many of these queries together in a UNION slighly improves performance
      const wordHashesSetSubmissionsByNewTagSetIdx = {}
      const wordHashesSetSubmissionsQueriesByNumTranslationWords = {}
      newTagSetTags.forEach((baseTag, newTagSetIdx) => {

        if(baseTag.t.length === 0 || baseTag.o.length === 0) return

        wordHashesSetSubmissionsByNewTagSetIdx[newTagSetIdx] = []
        wordHashesSetSubmissionsQueriesByNumTranslationWords[baseTag.t.length] = wordHashesSetSubmissionsQueriesByNumTranslationWords[baseTag.t.length] || []

        const getQueryWithSpecificTagStatus = status => `
          SELECT
            ${newTagSetIdx} AS newTagSetIdx,
            whss.id,
            whss.loc,
            whss.versionId,
            whss.wordsHash,
            ${baseTag.t.map((x, idx) => `
              whs${idx}.wordNumberInVerse AS 'wordHashesSubmissions.${idx}.wordNumberInVerse',
              ${/* whs${idx}.hash AS 'wordHashesSubmissions.${idx}.hash', */ ""}
              whs${idx}.withBeforeHash AS 'wordHashesSubmissions.${idx}.withBeforeHash',
              whs${idx}.withAfterHash AS 'wordHashesSubmissions.${idx}.withAfterHash',
              whs${idx}.withBeforeAndAfterHash AS 'wordHashesSubmissions.${idx}.withBeforeAndAfterHash',
            `).join("")}
            ts.id AS tagSetId,
            ts.tags,
            ts.autoMatchScores

          FROM wordHashesSetSubmissions AS whss
            LEFT JOIN tagSets AS ts ON (ts.loc = whss.loc AND ts.wordsHash = whss.wordsHash AND ts.versionId = whss.versionId)
            ${baseTag.t.map((x, idx) => `
              LEFT JOIN wordHashesSubmissions AS whs${idx} ON (whs${idx}.wordHashesSetSubmissionId = whss.id)
            `).join("")}

          WHERE whss.versionId IN (:versionIds)
            AND whss.loc REGEXP "${origLangVersionId === 'uhb' ? '^[0-3]' : '^[4-6]'}"
            AND ts.status = "${status}"
            ${baseTag.t.map((wordNumberInVerse, idx) => `
              AND whs${idx}.hash = "${hash64(wordByNumberInVerse[wordNumberInVerse].toLowerCase()).slice(0,6)}"
              ${idx === 0 ? `` : `
                AND whs${idx}.wordNumberInVerse > whs${idx-1}.wordNumberInVerse
                AND whs${idx}.wordNumberInVerse - whs${idx-1}.wordNumberInVerse <= 3
              `}
            `).join("")}

          LIMIT :limit
        `

        // doing a UNION is way faster than doing an ORDER BY since it doesn't have to first find all the results
        const wordHashesSetSubmissionsQuery = `
          SELECT * FROM ((
            ${getQueryWithSpecificTagStatus("none")}
          ) UNION (
            ${getQueryWithSpecificTagStatus("automatch")}
          )) AS tbl
        `

        wordHashesSetSubmissionsQueriesByNumTranslationWords[baseTag.t.length].push(wordHashesSetSubmissionsQuery)

      })

      await Promise.all(Object.values(wordHashesSetSubmissionsQueriesByNumTranslationWords).map(async queries => {

        const wordHashesSetSubmissionsGroup = await global.connection.query(
          `SELECT * FROM (( ${queries.join(' ) UNION ( ')} )) AS tbl2`,
          {
            nest: true,
            replacements: {
              versionIds: Object.keys(versionsById),
              limit: SUBMIT_TAG_SETS_CALC_ROW_LIMIT_PER_STATUS,
            },
            transaction: t,
          },
        )

        wordHashesSetSubmissionsGroup.forEach(({ newTagSetIdx, ...wordHashesSetSubmission }) => {
          wordHashesSetSubmissionsByNewTagSetIdx[newTagSetIdx].push(wordHashesSetSubmission)
        })

      }))

      const allWordHashesSetSubmissions = Object.values(wordHashesSetSubmissionsByNewTagSetIdx).flat()

      if(allWordHashesSetSubmissions.length > 0) {
        // doing the following as a separate query was a lot faster than using a subquery in the SELECT of the query above
        const wordHashesSetSubmissionIds = [ ...new Set(allWordHashesSetSubmissions.map(({ id }) => id)) ]
        const wordHashesSubmissionCounts = await global.connection.query(
          `
            SELECT
              whs.wordHashesSetSubmissionId,
              COUNT(*) AS cnt
            FROM wordHashesSubmissions AS whs
            WHERE whs.wordHashesSetSubmissionId IN (:wordHashesSetSubmissionIds)
            GROUP BY whs.wordHashesSetSubmissionId
          `,
          {
            nest: true,
            replacements: {
              wordHashesSetSubmissionIds,
            },
            transaction: t,
          },
        )
        const numTranslationWordsById = {}
        wordHashesSubmissionCounts.forEach(({ wordHashesSetSubmissionId, cnt }) => {
          numTranslationWordsById[wordHashesSetSubmissionId] = cnt
        })
        allWordHashesSetSubmissions.forEach(wordHashesSetSubmission => {
          wordHashesSetSubmission.numTranslationWords = numTranslationWordsById[wordHashesSetSubmission.id]
        })
      }

      const wordInfoSetByKey = await getWordInfoByIdAndPart({
        locAndVersionCombos: (
          allWordHashesSetSubmissions.map(({ versionId, loc }) => ({
            version: versionsById[versionId],
            loc,
          }))
        ),
        t,
      })

      newTagSetTags.forEach((baseTag, newTagSetIdx) => {
        if(baseTag.t.length === 0 || baseTag.o.length === 0) return

        const newTagSetRating = newTagSetRatings[newTagSetIdx]

        getAutoMatchTags({
          baseWordInfoByIdAndPart,
          baseWordHashesSubmissions,
          baseTag,
          newTagSetRating,
          wordHashesSetSubmissions: wordHashesSetSubmissionsByNewTagSetIdx[newTagSetIdx],
          wordInfoSetByKey,
        })

      })

      await updateAutoMatchTags()

    }

  } else {  // coming from submitWordHashesSet

    const { versionsById, baseWordInfoByIdAndPart, baseWordHashesSubmissions } = await getBaseAutoMatchTagInfo()

    const wordHashesSetSubmissions = await global.connection.query(
      `
        SELECT
          whss.id,
          whss.loc,
          whss.versionId,
          whss.wordsHash,
          whs.hash,
          whs.wordNumberInVerse,
          whs.withBeforeHash,
          whs.withAfterHash,
          whs.withBeforeAndAfterHash,
          ts.tags

        FROM wordHashesSetSubmissions AS whss
          LEFT JOIN wordHashesSubmissions AS whs ON (whs.wordHashesSetSubmissionId = whss.id)
          LEFT JOIN tagSets AS ts ON (ts.loc = whss.loc AND ts.wordsHash = whss.wordsHash AND ts.versionId = whss.versionId)

        WHERE whss.versionId IN (:versionIds)
          AND whss.loc REGEXP "${origLangVersionId === 'uhb' ? '^[0-3]' : '^[4-6]'}"
          AND whs.hash IN (:hash)
          AND ts.status IN ("unconfirmed", "confirmed")
          AND ts.autoMatchScores IS NULL

        ORDER BY FIELD(ts.status, "confirmed", "unconfirmed")
        LIMIT :limit
      `,
      {
        nest: true,
        replacements: {
          versionIds: Object.keys(versionsById),
          hash: baseWordHashesSubmissions.map(({ hash }) => hash),
          limit: WORD_HASHES_SUBMISSIONS_CALC_ROW_LIMIT,
        },
        transaction: t,
      },
    )

    const wordHashesSetSubmissionsByHash = {}
    wordHashesSetSubmissions.forEach(({ hash, ...wordHashesSetSubmission }) => {
      wordHashesSetSubmissionsByHash[hash] = wordHashesSetSubmissionsByHash[hash] || []
      wordHashesSetSubmissionsByHash[hash].push(wordHashesSetSubmission)
    })

    const wordInfoSetByKey = await getWordInfoByIdAndPart({
      locAndVersionCombos: (
        wordHashesSetSubmissions.map(({ versionId, loc }) => ({
          version: versionsById[versionId],
          loc,
        }))
      ),
      t,
    })

    baseWordHashesSubmissions.forEach(wordHashesSubmission => {

      getAutoMatchTags({
        baseWordInfoByIdAndPart,
        baseWordHashesSubmissions,
        baseWordNumberInVerse: wordHashesSubmission.wordNumberInVerse,
        wordHashesSetSubmissions: wordHashesSetSubmissionsByHash[wordHashesSubmission.hash] || [],
        wordInfoSetByKey,
      })

    })

    await updateAutoMatchTags()

  }

}

module.exports = calculateTagSets

/*
  NOTES on autoMatchScore calculation:
    matches parsings = 1000000
    exact word number progression (translation and original) = 300000 each
    one of...
      withBeforeAndAfterHash match = 200000
      withBeforeHash match = 100000
      withAfterHash match = 100000
    comparably small word placement percentage difference between orig and translation = 0-150000
    rating = rating (max out at 9999)
*/