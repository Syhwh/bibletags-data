module.exports = ({ connection, models }) => {

  return (
    queries,
    {
      input,
    },
    { req }
  ) => {

    const { loc, versionId, wordsHash, embeddingAppId, tagSubmissions } = input
    // look for auth, else use the id of the user with email = user-[deviceId]@bibletags.org
    let origLangVersion

    if(!tagSubmissions || tagSubmissions.length === 0) {
      throw(new Error(`No tags submitted.`))
    }

    tagSubmissions.forEach(tagSubmission => {
      const { uhbWordId, ugntWordId } = tagSubmission

      if(!uhbWordId === !ugntWordId) {
        throw(new Error(`Each tag must contain either a uhbWordId or ugntWordId, but not both.`))
      }

      const thisOrigLangVersion = uhbWordId ? 'uhb' : 'ugnt'
      
      if(origLangVersion && origLangVersion !== thisOrigLangVersion) {
        throw(new Error(`All tags in a single tagSet submission must relate to a single original language text.`))
      }
      
      origLangVersion = thisOrigLangVersion
    })

    delete input.tagSubmissions

    return connection.transaction(t => {
      return models.tagSetSubmission.create(input, {transaction: t}).then(tagSetSubmission => {
        tagSubmissions.forEach(tagSubmission => {
          tagSubmission.tagSetSubmissionId = tagSetSubmission.id
          tagSubmission.embeddingAppId = embeddingAppId  // do I need this data repeated here?
        })
        return models[`${origLangVersion}TagSubmission`].bulkCreate(tagSubmissions, {transaction: t})
          // .then()  Recalculate tagSets here
      })
    }).then(() => {

      const where = {
        loc,
        versionId,
        wordsHash,
      }

      return models.tagSet.findOne({
        where,
      })
    })
  }
}