const { hash64 } = require('@bibletags/bibletags-ui-helper')

const { getOrigLangVersionIdFromLoc, equalObjs, getObjFromArrayOfObjs, deepSortTagSetTags } = require('./utils')
const getWordInfoByIdAndPart = require('./getWordInfoByIdAndPart')

const calculateTagSets = async ({
  loc,
  versionId,
  wordsHash,
  t,
}) => {

  const { models } = global.connection

  const autoMatchTagSetUpdatesByUniqueKey = {}
  const origLangVersionId = getOrigLangVersionIdFromLoc(loc)

  const [ baseVersion, tagSetSubmissions ] = await Promise.all([

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
            require: false,
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
    versionsById,
    baseWordInfoByIdAndPart,
    baseWordHashesSubmissions,
    tag,
    newTagSetRating=0,
    wordHashesSetSubmissions,
    verseToUpdateInfo,
  }) => {

    const startFromTag = !!tag
    const usedWordIdAndPartNumbers = {}

    let fixedUniqueKey
    if(!startFromTag && !autoMatchTagSetUpdatesByUniqueKey[fixedUniqueKey]) {
      fixedUniqueKey = `${verseToUpdateInfo.loc} ${verseToUpdateInfo.versionId} ${verseToUpdateInfo.wordsHash}`
      autoMatchTagSetUpdatesByUniqueKey[fixedUniqueKey] = {
        tags: [],
        autoMatchScores: [],
        status: 'automatch',
        hasChange: true,
        ...verseToUpdateInfo,
      }
    }

    // for each wordHashesSetSubmissions
    await Promise.all(wordHashesSetSubmissions.map(async wordHashesSetSubmission => {

      const {

        loc,
        versionId,
        wordsHash,
        tagSetId,
        tags=[],

        // following relevant for new tag submission call only
        wordHashesSubmissions=[],
        autoMatchScores=[],

        // following relevant for new word hashes submission only
        wordNumberInVerse,
        withBeforeHash,
        withAfterHash,
        withBeforeAndAfterHash,

      } = wordHashesSetSubmission

      tag = tag || tags.find(tag => tag.t.includes(wordNumberInVerse))

      if(tag.o.length === 0 || tag.t.length === 0) return

      let wordHashesSubmissionsArray
      if(startFromTag) {
        wordHashesSubmissionsArray = Object.values(wordHashesSubmissions)
      } else if(tag.t.length === 1) {
        wordHashesSubmissionsArray = [{
          wordNumberInVerse,
          withBeforeHash,
          withAfterHash,
          withBeforeAndAfterHash,
        }]
      } else {
        return
        // TODO: to be able to get multi-translation-word tags upon word hash submission, I need to 
        // add in code here to (1) get the hashes of the other words in the found tag, (2) look 
        // in the verseToUpdateInfo spot to see if we have all those words, (3) form this array
      }

      const thisRowWordInfoByIdAndPart = await getWordInfoByIdAndPart({
        version: versionsById[versionId],
        loc,
        t,
      })

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
          if(!usedWordIdAndPartNumbers[wordInfo.wordIdAndPartNumber] && wordInfo.strongPart === strongPart) {

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

      // add to auto-match score for options with exact word number progression
      const bestMatchOptionInfo = { totalScoreAddition: -1 }
      origMatchOptions.forEach(origMatchOption => {
        const extraWordPartsBetween = origMatchOption.slice(1).map(({ wordPartNumberInVerse }, idx) => wordPartNumberInVerse - origMatchOption[idx].wordPartNumberInVerse)
        let totalScoreAddition = origMatchOption.reduce((a,b) => a + b.scoreAddition, 0)
        if(equalObjs(extraWordPartsBetweenEachOriginalWord, extraWordPartsBetween)) {
          totalScoreAddition += 300000
        }
        if(totalScoreAddition > bestMatchOptionInfo.totalScoreAddition) {
          bestMatchOptionInfo.totalScoreAddition = totalScoreAddition
          bestMatchOptionInfo.wordIdAndPartNumbers = origMatchOption.map(({ wordIdAndPartNumber }) => wordIdAndPartNumber)
        }
      })

      let newAutoMatchScore = newTagSetRating
      const newTag = {}

      // form newTag.o
      bestMatchOptionInfo.wordIdAndPartNumbers.forEach(wordIdAndPartNumber => {
        usedWordIdAndPartNumbers[wordIdAndPartNumber] = true
      })
      newTag.o = bestMatchOptionInfo.wordIdAndPartNumbers
      newAutoMatchScore += bestMatchOptionInfo.totalScoreAddition

      // form newTag.t
      newTag.t = wordHashesSubmissionsArray.map(({ wordNumberInVerse }) => wordNumberInVerse)

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
            baseWordHashesSubmissions[wordNumberInVerse-1][hashType] === wordHashesSubmission[hashType]
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
          status: 'automatch',
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
        autoMatchTagSetUpdates.hasChange = true
      }

    }))

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

  const addDefinitionUpdateItems = async ({ baseWordInfoByIdAndPart, alteredTags }) => {

    // find the definitionIds of tags that changed and add to wordTranslation + languageSpecificDefinition update queue
    await models.definitionUpdateItem.bulkCreate(
      (
        alteredTags
          .map(tag => (
            tag.o.map(wordIdAndPart => ({
              definitionId: baseWordInfoByIdAndPart[wordIdAndPart].strongPart,
            }))
          ))
          .flat()
      ),
      {
        validate: true,
        transaction: t,
      },
    )

  }

  if(tagSetSubmissions.length > 0) {  // coming from submitTagSet: update tagSet based on all submissions

    // each tag gets a rating
    const tagsByTagStr = {}
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
      if(rating < 2) return  // folks with ratings < 2 (they get more wrong than right!) are discounted

      tags.forEach(tag => {
        const tagAsStr = JSON.stringify(tag)
        if(tagsByTagStr[tagAsStr]) {
          tagsByTagStr[tagAsStr].rating *= rating
          tagsByTagStr[tagAsStr].numberOrAffirmations
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
        newTagSetRatings.push(rating)
        words.forEach(w => {
          usedWords[w] = true
        })
        confirmed = confirmed && numberOrAffirmations >= 2 && rating >= 50
      }
    })
    const newStatus = confirmed ? 'confirmed' : 'unconfirmed'
    deepSortTagSetTags(newTagSetTags)

    const tagSet = await models.tagSet.findOne({
      where: {
        loc,
        versionId,
        wordsHash,
      },
      transaction: t,
    })

    if(!tagSet) throw `Call to submitTagSet cannot proceed a call to submitWordHashesSet for the same verse`

    if(equalObjs(newTagSetTags, tagSet.tags)) {

      if(tagSet.status !== newStatus) {
        tagSet.status = newStatus
        await tagSet.update({transaction: t})
      }

    } else {

      // record changed tags

      const oldTagsStringified = tagSet.tags.map(tag => JSON.stringify(tag))
      const alteredTags = newTagSetTags.filter(tag => !oldTagsStringified.includes(JSON.stringify(tag)))

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

      await Promise.all(newTagSetTags.map(async (tag, newTagSetIdx) => {

        const newTagSetRating = newTagSetRatings[newTagSetIdx]

        const wordHashesSetSubmissions = await global.connection.query(
          `
            SELECT
              whss.id,
              whss.loc,
              whss.versionId,
              whss.wordsHash,
              ${tag.t.map((x, idx) => `
                whs${idx}.wordNumberInVerse AS 'wordHashesSubmissions.${idx}.wordNumberInVerse',
                ${/* whs${idx}.hash AS 'wordHashesSubmissions.${idx}.hash', */ ""}
                whs${idx}.withBeforeHash AS 'wordHashesSubmissions.${idx}.withBeforeHash',
                whs${idx}.withAfterHash AS 'wordHashesSubmissions.${idx}.withAfterHash',
                whs${idx}.withBeforeAndAfterHash AS 'wordHashesSubmissions.${idx}.withBeforeAndAfterHash',
              `).join("")}
              ts.id AS tagSetId,
              ts.tags,
              ts.autoMatchScores

            FROM wordHashesSetSubmissions as whss
              LEFT JOIN tagSets as ts ON (ts.loc = whss.loc AND ts.wordsHash = whss.wordsHash AND ts.versionId = whss.versionId)
              ${tag.t.map((x, idx) => `
                LEFT JOIN wordHashesSubmissions as whs${idx} ON (whs${idx}.wordHashesSetSubmissionId = whss.id)
              `).join("")}

            WHERE whss.versionId IN (:versionIds)
              AND (ts.id IS NULL OR (ts.status = "automatch" AND ts.autoMatchScores IS NOT NULL))
              ${tag.t.map((wordNumberInVerse, idx) => `
                AND whs${idx}.hash = "${hash64(wordByNumberInVerse[wordNumberInVerse])}"
                ${idx === 0 ? `` : `
                  AND whs${idx}.wordNumberInVerse > whs${idx-1}.wordNumberInVerse
                `}
              `).join("")}

            ORDER BY ts.id  ${/* Will bring the NULL values to the top so as to preference completed untagged items. */ ""}
            LIMIT 100
          `,
          {
            nest: true,
            replacements: {
              versionIds: Object.keys(versionsById),
            },
            transaction: t,
          },
        )

        await getAutoMatchTags({
          versionsById,
          baseWordInfoByIdAndPart,
          baseWordHashesSubmissions,
          tag,
          newTagSetRating,
          wordHashesSetSubmissions,
        })

      }))

      await updateAutoMatchTags()
      await addDefinitionUpdateItems({ baseWordInfoByIdAndPart, alteredTags })

    }

  } else {  // coming from submitWordHashesSet

    const { versionsById, baseWordInfoByIdAndPart, baseWordHashesSubmissions } = await getBaseAutoMatchTagInfo()

    await Promise.all(baseWordHashesSubmissions.map(async wordHashesSubmission => {

      const wordHashesSetSubmissions = await global.connection.query(
        `
          SELECT
            whss.id,
            whss.loc,
            whss.versionId,
            whss.wordsHash,
            whs.wordNumberInVerse,
            whs.withBeforeHash,
            whs.withAfterHash,
            whs.withBeforeAndAfterHash,
            ts.tags

          FROM wordHashesSetSubmissions as whss
            LEFT JOIN wordHashesSubmissions as whs ON (whs.wordHashesSetSubmissionId = whss.id)
            LEFT JOIN tagSets as ts ON (ts.loc = whss.loc AND ts.wordsHash = whss.wordsHash AND ts.versionId = whss.versionId)

          WHERE whss.versionId IN (:versionIds)
            AND whs.hash = :hash
            AND ts.status IN ("unconfirmed", "confirmed")
            AND ts.autoMatchScores IS NULL

          ORDER BY FIELD(ts.status, "confirmed", "unconfirmed")
          LIMIT 100
        `,
        {
          nest: true,
          replacements: {
            versionIds: Object.keys(versionsById),
            hash: wordHashesSubmission.hash,
          },
          transaction: t,
        },
      )

      await getAutoMatchTags({
        versionsById,
        baseWordInfoByIdAndPart,
        baseWordHashesSubmissions,
        wordHashesSetSubmissions,
        verseToUpdateInfo: {
          loc,
          versionId,
          wordsHash,
        },
      })

    }))

    await updateAutoMatchTags()

    const updatedTagSet = await models.tagSet.findOne({
      where: {
        loc,
        versionId,
        wordsHash,
      },
      transaction: t,
    })

    await addDefinitionUpdateItems({
      baseWordInfoByIdAndPart,
      alteredTags: updatedTagSet.tags,
    })

  }


  // what to calculate
    // new tagSet submission

      // all
        // run specific loc/versionId/wordsHash on all combos, unless this proves to take forever, in which case I should find shortcuts

      // specific loc/versionId/wordsHash
        // (a) evaluate all submissions for this loc/versionId/wordsHash
        // (b) update tagSets and update/insert tagSetItems, if any have changed
        // (c) [if changed, then]

          // for each tag
            // get all the tagSetItem sets where
              // version.languageId matches (doesn't have to be same versionId or wordsHash)  
              // ids match each other
              // sets contain all hashes in the tag, in the same order
              // match level is not already highest possible
              // only tagSet.loc's where vs contains all the definitionIds in the tag
            // if it is a better match, update it

            // match levels sumation
              // matches parsings = 1000000
              // exact word number progression (translation and original) = 500000
              // one of
                // withBeforeAndAfterHash match = 200000
                // withBeforeHash match = 100000
                // withAfterHash match = 100000
              // rating = rating (max out at 99999)


              // matches parsings + exact word number progression (translation and original) + withBeforeAndAfterHash match
              // matches parsings + exact word number progression (translation and original) + withBeforeHash match
              // matches parsings + exact word number progression (translation and original) + withAfterHash match
              // matches parsings + exact word number progression (translation and original) + hash match
              // matches parsings + withBeforeAndAfterHash match
              // matches parsings + withBeforeHash match
              // matches parsings + withAfterHash match
              // matches parsings + hash match
              // exact word number progression (translation and original) + withBeforeAndAfterHash match
              // exact word number progression (translation and original) + withBeforeHash match
              // exact word number progression (translation and original) + withAfterHash match
              // exact word number progression (translation and original) + hash match
              // withBeforeAndAfterHash match
              // withBeforeHash match
              // withAfterHash match
              // hash match

          // for definitionId of all words in updated verse
            // update wordTranslations as appropriate (for all relevant versions)
            // recalculate languageSpecificDefinitions
            // update languageSpecificDefinitions if changed

    // new wordHashesSetSubmission
      // for each word, get relevant loc/versionId/wordsHash combos and run (c) above, but only on this loc


  // tables drawing from
    // tagSetSubmissions
    // tagSetSubmissionItems
    // tagSetSubmissionItemTranslationWords
    // uhbTagSubmissions
    // ugntTagSubmissions
    // users
    // userRatingAdjustments
    // wordHashesSubmissions
    // wordHashesSetSubmissions

  // tables being created
    // tagSets
    // wordTranslations
    // languageSpecificDefinitions
      // allow editor version

  // ** weed out bad embedding apps!

}

module.exports = calculateTagSets


// autoMatchScore calculation
  // matches parsings = 1000000
  // exact word number progression (translation and original) = 300000 each
  // one of
    // withBeforeAndAfterHash match = 200000
    // withBeforeHash match = 100000
    // withAfterHash match = 100000
  // rating = rating (max out at 99999)