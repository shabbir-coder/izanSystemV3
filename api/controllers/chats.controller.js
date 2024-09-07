const axios = require('axios');
const Instance = require('../models/instanceModel')
const {Message, Contact, ChatLogs} = require('../models/chatModel');
const Campaign = require('../models/campaignModel');
const Event = require('../models/event.Model');
const User = require('../models/user');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs')
const { getCachedData } = require('../middlewares/cache');
const moment = require('moment-timezone');
const handlebars = require('handlebars');
const csv = require('csvtojson');
const dataKey = 'activeSet';
const xlsx = require('xlsx');
const pdf = require('html-pdf');
const path = require('path');

const saveContact = async(req, res)=>{
    try {
      const { name, number, instanceId, eventId, param1, param2, param3, ...daysData } = req.body;

      const existingContact = await Contact.findOne({
        eventId,
        $or: [
          { name },
          { number }
        ]
      });
  
      if (existingContact) {
        let errorMessage = 'Contact already exists with the same ';
        const errors = [];
        if (existingContact.name === name) errors.push('name');
        if (existingContact.number === number) errors.push('number');

        errorMessage += errors.join(' or ') + '.';

        return res.status(400).send({ error: errorMessage });
      } 

      const days = Object.keys(daysData)
      .filter(key => key.startsWith('day'))
      .map(dayKey => ({
        day: dayKey, // 'day1', 'day2', etc.
        inviteStatus: daysData[dayKey], // Assign the invite status from the corresponding day field
        invitesAllocated: daysData[`invitesAllocated_${dayKey}`] || 0,
        invitesAccepted: daysData[`invitesAccepted_${dayKey}`] || 0,
        attendeesCount: daysData[`attendeesCount_${dayKey}`] || 0
      }));

      const contact = new Contact({
        name,
        number,
        instanceId,
        eventId,
        param1,
        param2,
        param3,
        days,
        createdBy: req.user.userId
      });

        await contact.save();
        return res.status(201).send(contact);
      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}

const saveContactsInBulk = async(req, res) => {
  try {
    const filePath = req.file.path;
    const {instanceId, eventId} = req.body;

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

    const headers = sheet[0];
    const rows = sheet.slice(1)

    const event = await Event.findOne({ _id: eventId });

    const contacts = rows.map(row => {
      let contact = {
        name: row[headers.indexOf('name')],
        number: row[headers.indexOf('number')],
        days: [],
        createdBy: req.user.userId,
        instanceId: instanceId || null,
        eventId: eventId || null,
      };
            // Map day-wise invites
        for (let i = 1; i <= event.subEventDetails.length ; i++) {
          const dayInvite = row[headers.indexOf(`day${i}`)];
          if (dayInvite) {
            contact.days.push({
              invitesAllocated: dayInvite,
              invitesAccepted: 0, // Initial value, can be updated later
              inviteStatus: 'Pending', // Default status
            });
          }else{
            contact.days.push({
              invitesAllocated: 0,
              invitesAccepted: 0, // Initial value, can be updated later
              inviteStatus:'', // Default status
            });
          }
        }
  
        return contact;
      });

    await Contact.insertMany(contacts);

    res.status(201).json({ message: 'Contacts saved successfully' });
  } catch (error) {
    console.log(error)
    res.status(500).json({ error: 'An error occurred while saving contacts' });
  }
}

const getContact = async(req, res)=>{
    try {
      let query = {};
      const { page = 1, limit = 10, searchtext, eventId, filter, day } = req.query;

      if (eventId) {
        query.eventId = eventId;
      }
      
      if (searchtext) {
        query.$or = [
          { name: { $regex: new RegExp(searchtext, 'i') } },
          { number: { $regex: new RegExp(searchtext, 'i') } }
        ];
      }

      if (day) {
        const dayIndex = parseInt(day);
  
        // Check for contacts with invitesAllocated not equal to 0 for that day
        query[`days.${dayIndex}.invitesAllocated`] = { $ne: 0 };
  
        // If filter (status) is also provided, filter by inviteStatus for that day
        if (filter) {
          query[`days.${dayIndex}.inviteStatus`] = filter;
        }
      } else if (filter) {
        // If no day is provided but filter (status) is, filter by overAllStatus
        query.overAllStatus = filter;
      }

      console.log({query})
      const Contacts = await Contact.find(query)
        .skip((page - 1) * limit)
        .limit(limit);

      const count = await Contact.countDocuments(query)

      return res.status(200).json({data: Contacts, total: count});

      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}

const updateContacts = async(req, res)=>{
    try {
        const { id } = req.params;
        const { isAdmin, name, number, instanceId, eventId, param1, param2, param3, days } = req.body;

        // Find the contact and update its data, including days
        const contact = await Contact.findByIdAndUpdate(
          id,
          {
            name,
            number,
            instanceId,
            eventId,
            param1,
            param2,
            param3,
            days,
            isAdmin,
            updatedAt: new Date()
          },
          { new: true }
        );

        if (!contact) {
          return res.status(404).send({ message: 'Contact not found' });
        }

        res.status(200).send(contact);
      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}

const getMessages = async (req, res)=>{
    try {
        const {senderNumber, instanceId, limit = 20, offset = 0 } = req.body;
        
        const instance = await Instance.findOne({_id:instanceId})

        const senderId = req.user.userId;
        
        // console.log(senderNumber, instance?.instance_id)
        // console.log(senderId)

        const messages = await Message.find({ 
          senderNumber: ''+ senderNumber,
          instanceId: instance.instance_id     
         }).sort({ createdAt: -1 })
         .skip(offset * limit)
         .limit(limit);

         const count = await Message.countDocuments({
          senderNumber: ''+ senderNumber,
          instanceId: instance.instance_id 
         })
        res.status(200).send({messages,count});
      } catch (error) {
        // console.log(error)
        return res.status(500).send({ error: error.message });
      }
}

const processContact = async (number, instance, campaign, messageTrack,  message, media, mime, messageType) => {
  const sendMessageObj = {
    number: number,
    type: 'text',
    instance_id: instance?.instance_id,
  }; 

    let reply = message;
    if (media) {
      sendMessageObj.filename = media.split('/').pop();
      sendMessageObj.media_url = process.env.IMAGE_URL + media;
      sendMessageObj.type = 'media';
    }
    
    const response = await sendMessageFunc({ ...sendMessageObj, message: reply });
    
    const updateContact = await Contact.findOne({number, eventId: campaign?._id })
    // console.log(updateContact)

    if(messageType==='invite'){
      updateContact.overAllStatus='Pending',
      updateContact.hasCompletedForm = false;
    }else if(messageType==='accept'){
      updateContact.overAllStatus='Accepted',
      updateContact.hasCompletedForm = true
    }else if(messageType==='rejection'){
      updateContact.overAllStatus='Rejected',
      updateContact.hasCompletedForm = true
    }

    updateContact.days = updateContact.days.map((day) => {
      if (day.invitesAllocated && day.invitesAllocated !== '0') {
        switch (messageType) {
          case 'invite':
            day.inviteStatus = 'Pending';
            day.invitesAccepted = '0';
            break;
          case 'accept':
            day.inviteStatus = 'Accepted';
            if (day.invitesAllocated.toLowerCase() !== 'all') {
              day.invitesAccepted = day.invitesAllocated;
            }
            break;
          case 'rejection':
            day.inviteStatus = 'Rejected';
            day.invitesAccepted = '0';
            break;
        }
      }
      return day;
    });

    const NewChatLog = await ChatLogs.findOneAndUpdate(
      {
        senderNumber: number,
        instanceId: instance?.instance_id,
        eventId: campaign._id,
      },
      {
        $set: {
          messageTrack: messageTrack,
          finalResponse:'',
          isCompleted: false,
          inviteStatus: updateContact.overAllStatus,
          updatedAt: Date.now(),
        },
        $unset :{
          inviteIndex: 1
        }
      },
      {
        upsert: true,
        new: true,
      }
    );
    await updateContact.save()
  
};

const sendMessagesWithDelay = async (numbers, instance, campaign, messageTrack,  message, media, mime, messageType) => {
  for (let i = 0; i < numbers.length; i++) {
    await processContact(numbers[i], instance, campaign, messageTrack, message, media, mime, messageType);
    await new Promise(resolve => setTimeout(resolve, 7500)); // Delay of 7 seconds between each message
  }
};

const sendBulkMessage = async (req, res) => {
  try {
   
    const { instance_id, eventId, message, media, mime, number, filter, messageTrack , messageType} = req.body;
    const senderId = req.user.userId;

    let messageNumbers = number;

    const instance = await Instance.findOne({ _id: instance_id });
    const campaign = await Event.findOne({ _id: eventId });
    if(!number?.length){
      const contactQuery ={eventId: eventId}
      // const numbers = await getNumbers(eventId)


      // if (filter) {
      //   if (filter === 'Accepted') {
      //     query.number = { $in: numbers.yesContacts };
      //   } else if (filter === 'Rejected') {
      //     query.number = { $in: numbers.noContacts };
      //   } else if (filter === 'Pending') {
      //     query.number = { $in: numbers.unresponsiveContacts };
      //   }
      // }
      if (filter) {
        if (filter === 'Accepted') {
          contactQuery.inviteStatus = 'Accepted';
        } else if (filter === 'Rejected') {
          contactQuery.inviteStatus = 'Rejected';
        } else if (filter === 'Pending') {
          contactQuery.inviteStatus = 'Pending';
        }
      }

      
      const contacts = await Contact.find(contactQuery);
      messageNumbers = contacts.map(contact => contact.number);
    }

    // Run the message sending task asynchronously
    sendMessagesWithDelay(messageNumbers, instance, campaign, messageTrack, message, media, mime, messageType)
      .then(() => {
        console.log('All messages sent');
      })
      .catch(error => {
        console.error('Error sending messages:', error);
      });

    // Send an immediate response to the client
    return res.status(201).send({ message: 'Message sending job queued' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
};

const sendMessages = async (req, res)=>{
  try {

    const { numbers, instance_id, eventId, message, messageTrack, messageType } = req.body;

    const senderId = req.user.userId
    const instance = await Instance.findOne({_id:instance_id})
    // Save the message to the database
    let start = new Date();
    start.setHours(0,0,0,0);

    let end = new Date();
    end.setHours(23,59,59,999);
    console.log('numbers', numbers)
    const campaign = await Event.findOne({_id: eventId})
    for(let number of numbers){
      console.log('number',number)
      const sendMessageObj={
        number: number,
        type: 'text',
        instance_id: instance?.instance_id,
      }

      const updateContact = await Contact.findOne({number, eventId })
      // console.log(updateContact)
  
      if(messageType==='invite'){
        updateContact.inviteStatus='Pending',
        updateContact.attendeesCount='0'
        updateContact.updatedAt = Date.now()
        await updateContact.save()
      }else if(messageType==='accept'){
        updateContact.updatedAt = Date.now()
        updateContact.inviteStatus='Accepted',
        await updateContact.save()
      }else if(messageType==='rejection'){
        updateContact.updatedAt = Date.now()
        updateContact.attendeesCount = '0'
        updateContact.inviteStatus='Rejected',
        await updateContact.save()
      }
  

      if(messageTrack==1){
  
        let reply = campaign?.invitationText
        if(campaign?.invitationMedia){              
          sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
          sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
          sendMessageObj.type = 'media';
        }
        const response = await sendMessageFunc({...sendMessageObj,message: reply });
        const NewChatLog = await ChatLogs.findOneAndUpdate(
          {
            senderNumber: number,
            instanceId: instance?.instance_id,
            eventId : campaign._id,
            messageTrack:  1
          },
          {
            $set: {
              updatedAt: Date.now(),
            }
          },
          {
            upsert: true, // Create if not found, update if found
            new: true // Return the modified document rather than the original
          }
        )
      }else{
        const NewChatLog = await ChatLogs.findOneAndUpdate(
          {
            senderNumber: number,
            instanceId: instance?.instance_id,
            eventId : campaign._id,
          },
          {
            $set: {
              messageTrack:  messageTrack,
              inviteStatus : updateContact.inviteStatus,
              updatedAt: Date.now(),
            }
          },
          {
            upsert: true, // Create if not found, update if found
            new: true // Return the modified document rather than the original
          }
        )
        const response = await sendMessageFunc({...sendMessageObj,message });

      }
    }

    // console.log('response', response.data)
    
    return res.status(201).send({message:'mesg sent'});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.data });
  }
}


const recieveMessagesV1 = async (req, res)=>{
  try{
    const messageObject = req.body;
    // console.log(req.body?.data?.event)
    // if(messageObject.data?.data?.messages?.[0]?.key?.fromMe === true) return res.send()
    if(["messages.upsert"].includes(req.body?.data?.event)){
      let message;
      message = messageObject.data.data.messages?.[0]?.message?.extendedTextMessage?.text || messageObject.data.data.messages?.[0]?.message?.conversation || '';
      let remoteId = messageObject.data.data.messages?.[0]?.key.remoteJid.split('@')[0];

      let fromMe = messageObject.data.data.messages?.[0]?.key?.fromMe
      let messageId = messageObject.data.data.messages?.[0]?.key?.id
      let timeStamp = messageObject.data.data.messages?.[0]?.messageTimestamp

      if(isNaN(remoteId.length)||remoteId.length>13){
        return res.send('invalid number')
      }

      let start = new Date();
      start.setHours(0,0,0,0);

      let end = new Date();
      end.setHours(23,59,59,999);


      // console.log('message', messageObject.data.data.messages?.[0]?.message)
      // console.log('remoteId', remoteId)

      const recieverId = await Instance.findOne({instance_id: messageObject.instance_id})
      const senderId = await Contact.findOne({number: remoteId, eventId: recieverId?.eventId })

      // console.log(recieverId)
      if(!senderId) return res.send('No contacts in db');
      const currentTime = new Date();
      currentTime.setHours(currentTime.getHours() + 2);
      const updatedTimeISO = currentTime.toISOString();
      
      const previMessage = await Message.findOne({
        senderNumber: remoteId,
        recieverId : recieverId?._id,
        eventId: recieverId?.eventId,
        fromMe: false
      }).sort({createdAt: -1})

      // console.log('previMessage', previMessage)
      const newMessage = {
        recieverId : recieverId?._id,
        senderNumber: remoteId,
        instanceId: messageObject?.instance_id,
        eventId: recieverId?.eventId,
        fromMe: fromMe,
        text: message,
        type: 'text',
        messageId,
        timeStamp: updatedTimeISO
      }
	    console.log('here')
      const savedMessage = new Message(newMessage);
      await savedMessage.save();

      const sendMessageObj={
        number: remoteId,
        type: 'text',
        instance_id: messageObject?.instance_id,
      }

      const tempEvent = await Event.findOne({_id: senderId.eventId})

      if(message.toLowerCase()===tempEvent?.ReportKeyword && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');

        const fileName = await getReportdataByTime(start,end, recieverId?._id, tempEvent?._id ,rejectregex)
        // console.log('fileName', fileName)
        // const fileName = 'http://5.189.156.200:84/uploads/reports/Report-1716394369435.csv'
        sendMessageObj.filename = fileName.split('/').pop();
        sendMessageObj.media_url= process.env.IMAGE_URL+fileName;
        sendMessageObj.type = 'media';
        const response =  await sendMessageFunc({...sendMessageObj, message:'Download report'});
        return res.send(true);
      }

      if(message.toLowerCase()==='report dump' && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');

        const fileName = await getFullReport(start,end, recieverId?._id, tempEvent?._id ,rejectregex)
        // console.log('fileName', fileName)
        // const fileName = 'http://5.189.156.200:84/uploads/reports/Report-1716394369435.csv'
        sendMessageObj.filename = fileName.split('/').pop();
        sendMessageObj.media_url= process.env.IMAGE_URL+fileName;
        sendMessageObj.type = 'media';
        const response =  await sendMessageFunc({...sendMessageObj, message:'Download report dump'});
        return res.send(true);
      }
      
      if(message.toLowerCase()===tempEvent?.StatsKeyword && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }

        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');

        const replyObj = await getStats1(tempEvent?._id , recieverId,'','', rejectregex);

        let replyMessage = '*Statistics*';
        replyMessage += '\n\n';
        replyMessage += `\n● Total nos of Invitees *${replyObj?.totalContacts}*`;
        replyMessage += `\n● Yes *${replyObj?.yes}*`;
        replyMessage += `\n● Guests Count *${replyObj?.guestCount}*`;
        replyMessage += `\n● No *${replyObj?.no}*`;
        replyMessage += `\n● Balance *${replyObj?.balance}*`;
        
        const response = await sendMessageFunc({...sendMessageObj, message: replyMessage});
        return res.send(true);
      }

      if(message.toLowerCase() === `${tempEvent.initialCode}/${tempEvent?.newContactCode}` && senderId?.isAdmin){
        // console.log('message', message)
        let reply = 'Send new contact detail in following pattern.\nYou can copy the next message and send it again with your contact details';
        let Newreply = 'New_Contact\n'
        Newreply += '\nName: John Doe'
        Newreply += '\nInvites: 1/2/3/all'
        Newreply += '\nISD code: 91'
        Newreply += '\nNumber: 9999999999'
        Newreply += '\nParam1: '
        Newreply += '\nParam2: '
        Newreply += '\nParam3: '

        const response1 = await sendMessageFunc({...sendMessageObj,message: reply });
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response2 = await sendMessageFunc({...sendMessageObj,message: Newreply });

        return res.send('not a valid code')
      }
     
      if (previMessage && previMessage.text.toLowerCase() === `${tempEvent.initialCode}/${tempEvent?.newContactCode}` && senderId?.isAdmin && !newMessage.fromMe) {
        // console.log('new_contact', message.split('\n')[0].toLowerCase())
        if (message.split('\n')[0].toLowerCase() === 'new_contact') {
          const result = {};
          const lines = message.split('\n');
          // console.log('split', lines);
      
          lines.slice(2).forEach(item => {
            let [key, value] = item.split(':').map(part => part.trim());
            key = key.toLowerCase().replace(/ /g, ''); // Normalize key
      
            if (key === 'name') {
              result.name = value || null;
            } else if (key === 'invites') {
              result.invites = value || null;
            } else if (key === 'isdcode') {
              result.isdCode = value || '';
            } else if (key === 'number') {
              result.number = (result.isdCode ? result.isdCode : '') + (value || '');
            } else {
              result[key] = value || null;
            }
          });
      
          result['createdBy'] = senderId?._id;
          result['instanceId'] = recieverId?._id || null;
          result['eventId'] = recieverId?.eventId;
          result['inviteStatus'] = 'Pending';
      
          const { name, number } = result; // Extract name and number from result
      
          const existingContact = await Contact.findOne({
            eventId: recieverId?.eventId,
            $or: [
              { name },
              { number }
            ]
          });
      
          if (existingContact) {
            let errorMessage = 'Contact already exists with the same ';
            const errors = [];
            if (existingContact.name === name) errors.push('name');
            if (existingContact.number === number) errors.push('number');
      
            errorMessage += errors.join(' or ') + '.';
            const response = await sendMessageFunc({...sendMessageObj,message: errorMessage });
            return res.status(400).send({ error: errorMessage });
          }
      
          const contact = new Contact(result);
          await contact.save(); // Ensure the save operation is performed
          const response = await sendMessageFunc({...sendMessageObj,message: 'Contact saved' });
          return res.status(201).send('contact');
        }
      }
      

      const previousChatLog = await ChatLogs.findOne(
        {
          senderNumber: remoteId,
          instanceId: messageObject?.instance_id,
          eventId: senderId.eventId
        },
      ).sort({ updatedAt: -1 });
      // console.log('previousChatLog',previousChatLog)
      if(fromMe) {
        const campaign = await Event.findOne({_id: recieverId?.eventId})
        const code = message.split('/') 
        if(code[0].toLowerCase() === campaign.initialCode.toLowerCase()){
          const codeType = code[1].toLowerCase()

          if(codeType === campaign.inviteCode){

            let reply = campaign?.invitationText
            if(campaign?.invitationMedia){              
              sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
              sendMessageObj.type = 'media';
            }
            senderId.lastResponse = '';
            senderId.lastResponseUpdatedAt= Date.now();
            senderId.attendeesCount = '0';
            senderId.inviteStatus ='Pending';
            await senderId.save()

            const response = await sendMessageFunc({...sendMessageObj,message: reply });

            const NewChatLog = await ChatLogs.findOneAndUpdate(
              {
                senderNumber: remoteId,
                instanceId: messageObject?.instance_id,
                eventId : campaign._id,
                inviteStatus: 'Pending',
                messageTrack:  1
              },
              {
                $set: {
                  updatedAt: Date.now(),
                }
              },
              {
                upsert: true, // Create if not found, update if found
                new: true // Return the modified document rather than the original
              }
            )

            return res.send('invitemessageSend')

          } else if(codeType === campaign.acceptCode){

            let reply = campaign?.thankYouText
            if(campaign?.thankYouMedia){              
              sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
              sendMessageObj.type = 'media';
            }

            if(senderId.invites!='1'){
              if(code[2]){
                senderId.lastResponse = message;
                senderId.lastResponseUpdatedAt= Date.now();
                senderId.attendeesCount = code[2];
                senderId.inviteStatus ='Accepted';
              }else{
                previousChatLog.messageTrack = 2;
                previousChatLog.save()
                reply = campaign?.messageForMoreThanOneInvites
                const response = await sendMessageFunc({...sendMessageObj,message: reply });
                return res.send('More Invites')
              }
            }else{
              senderId.lastResponse = message;
              senderId.lastResponseUpdatedAt= Date.now();
              senderId.attendeesCount = senderId.invites;
              senderId.inviteStatus ='Accepted';
            }
            
            previousChatLog.messageTrack = 3;
            previousChatLog.finalResponse = message;
            previousChatLog.inviteStatus = 'Accepted';
            previousChatLog.updatedAt= Date.now();

            // console.log('previousChatLog',previousChatLog);
            await senderId.save();
            await previousChatLog.save(); 
            const response = await sendMessageFunc({...sendMessageObj,message: reply }); 
            return res.send('acceptmessageSend')

          } else if(codeType === campaign.rejectCode){
            previousChatLog['messageTrack']=3;
            previousChatLog['finalResponse']=message.toLowerCase();
            previousChatLog.updatedAt= Date.now();
            let reply = campaign?.messageForRejection

            if(true){
              if(senderId.inviteStatus==='Accepted' && code[2]<senderId.attendeesCount){
                senderId.lastResponse = message;
                senderId.lastResponseUpdatedAt= Date.now();
                senderId.attendeesCount = (+senderId.attendeesCount)-(+code[2])
                await senderId.save()
                reply = campaign?.thankYouText
                  if(campaign?.thankYouMedia){              
                    sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
                    sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
                    sendMessageObj.type = 'media';
                  }

              }else{
                senderId.lastResponse = message;
                senderId.lastResponseUpdatedAt= Date.now();
                senderId.inviteStatus ='Rejected';
                senderId.attendeesCount = '0'
                await senderId.save()
                previousChatLog.inviteStatus = 'Rejected';
              }
            }

            await previousChatLog.save()
            const response = await sendMessageFunc({...sendMessageObj,message: reply }); 

            return res.send('rejectmessageSend')

          }
        }
        return res.send('nothing')
      }

      let reply;
      // console.log('previousChatLog', previousChatLog)


      if(!previousChatLog){
        const campaignData = await Event.find({_id: recieverId.eventId})
        console.log({campaignData})
        for (let campaign of campaignData){
          let contact;
          if(true){
            contact = await Contact.findOne({number: remoteId, eventId: campaign?._id.toString()})
            // console.log({contact})
            if(!contact) {
              // reply = campaign.numberVerificationFails;
              // const response = await sendMessageFunc({...sendMessageObj,message: reply });
              return res.send('Account not found')
            }
          }
          if(campaign.startingKeyword.toLowerCase() === message.toLowerCase()){
            const currentTime = moment();
           
            const startingTime = moment(campaign.startDate)
            .set('hour', campaign.startHour)
            .set('minute', campaign.startMinute);
      
          const endingTime = moment(campaign.endDate)
            .set('hour', campaign.endHour)
            .set('minute', campaign.endMinute);

            if (!currentTime.isBetween(startingTime, endingTime)) {
              const response =  await sendMessageFunc({...sendMessageObj,message: campaign?.messageForClosedInvitations });
              return res.send(true);      
            }
            let reply = campaign?.invitationText
            if(campaign?.invitationMedia){              
              sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
              sendMessageObj.type = 'media';
            }
            const response = await sendMessageFunc({...sendMessageObj,message: reply });
            const NewChatLog = await ChatLogs.findOneAndUpdate(
              {
                senderNumber: remoteId,
                instanceId: messageObject?.instance_id,
                updatedAt: { $gte: start, $lt: end },
                eventId : campaign._id,
                messageTrack:  1
              },
              {
                $set: {
                  updatedAt: Date.now(),
                  isValid: contact? true: false
                }
              },
              {
                upsert: true, // Create if not found, update if found
                new: true // Return the modified document rather than the original
              }
            )
            return res.send('firstMessage sent')
          }
        }
        return res.send('No active campaign found')
       
      }

      const campaign = await Event.findOne({_id: previousChatLog?.eventId})

      if(campaign?.RewriteKeyword?.toLowerCase() === message?.toLowerCase()){
        if(!previousChatLog || previousChatLog.messageTrack===1){
          const response =  await sendMessageFunc({...sendMessageObj,message: 'Nothing to cancel' });
          return res.send(true);
        }
        previousChatLog['messageTrack']=1
        previousChatLog['finalResponse']=''
        previousChatLog['inviteStatus']='Pending'
        await previousChatLog.save()
        if(true){
          senderId.lastResponse = '';
          senderId.lastResponseUpdatedAt= Date.now();
          senderId.inviteStatus ='Pending';
          senderId.attendeesCount='0'
          senderId.save();
        }
        let reply = campaign?.invitationText
          if(campaign?.invitationMedia){              
            sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
            sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
            sendMessageObj.type = 'media';
          }
        const response =  await sendMessageFunc({...sendMessageObj,message: reply });
        return res.send('after change message')
      }

      if(campaign.startingKeyword.toLowerCase() === message.toLowerCase()){
        const currentTime = moment();
        
        const startingTime = moment(campaign.startDate)
        .set('hour', campaign.startHour)
        .set('minute', campaign.startMinute);
  
      const endingTime = moment(campaign.endDate)
        .set('hour', campaign.endHour)
        .set('minute', campaign.endMinute);

        if (!currentTime.isBetween(startingTime, endingTime)) {
          const response =  await sendMessageFunc({...sendMessageObj,message: campaign?.messageForClosedInvitations });
          return res.send(true);      
        }
        let reply = campaign?.invitationText
        if(campaign?.invitationMedia){              
          sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
          sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
          sendMessageObj.type = 'media';
        }
        const response = await sendMessageFunc({...sendMessageObj,message: reply });
        const NewChatLog = await ChatLogs.findOneAndUpdate(
          {
            senderNumber: remoteId,
            instanceId: messageObject?.instance_id,
            eventId : campaign._id,
          },
          {
            $set: {
              updatedAt: Date.now(),
              messageTrack:  1
            }
          },
          {
            upsert: true, // Create if not found, update if found
            new: true // Return the modified document rather than the original
          }
        )
        return res.send('firstMessage sent')
      }
      
      // console.log({campaign})
	  
	  if(previousChatLog?.messageTrack===2){
        const numbersString = extractNumberOrAll(message.toLowerCase());
        function extractNumberOrAll(input) {
          const numberMatch = input.match(/\d+/);
          if (numberMatch) {
            return numberMatch[0];
          } else if (/\ball\b/i.test(input)) {
            return "all";
          } else {
            return null; // or any default value you want to return if neither is found
          }
        }
        if(numbersString !== null && (numbersString == senderId.invites.toLowerCase() || (senderId.invites.toLowerCase() === "all" || (!isNaN(numbersString) && +numbersString <= senderId.invites)))){
          console.log(numbersString)
          let reply = campaign?.thankYouText
          if(campaign?.thankYouMedia){              
            sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
            sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
            sendMessageObj.type = 'media';
          }

          previousChatLog.messageTrack = 3;
          previousChatLog.finalResponse=message;
          previousChatLog.updatedAt=Date.now();
          previousChatLog.inviteStatus = 'Accepted';
          // console.log('previousChatLog',previousChatLog);
          await previousChatLog.save(); 
  
          senderId.lastResponse = message;
          senderId.lastResponseUpdatedAt= Date.now();
          senderId.attendeesCount = numbersString==='all'?'5': numbersString;
          senderId.inviteStatus ='Accepted';
          await senderId.save()

          const response = await sendMessageFunc({...sendMessageObj,message: reply }); 
          return res.send('thank you send')
        }else{
          const response = await sendMessageFunc({...sendMessageObj,message: 'Invalid Input' }); 
          return res.send('Invalid Input')
        }
      }

      const acceptregex = new RegExp(`\\b${campaign.acceptanceKeyword}\\b`, 'i');

      if(acceptregex.test(message.trim())){
        if( previousChatLog?.finalResponse){
          const reply =`Your data is already saved . Type *${campaign.RewriteKeyword}* to edit your choice`
          const response = await sendMessageFunc({...sendMessageObj,message: reply });
          return res.send('Type Change First')
        }
        previousChatLog['messageTrack']=2;
        await previousChatLog.save()
        if(true){
          const contact = await Contact.findOne({
            number: remoteId,
            eventId: campaign?._id
          })
          // console.log({contact})
          if(contact.invites!='1'){
            reply = campaign?.messageForMoreThanOneInvites
            const response = await sendMessageFunc({...sendMessageObj,message: reply });
            return res.send('More Invites')
          }else{
            let reply = campaign?.thankYouText
            if(campaign?.thankYouMedia){              
              sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
              sendMessageObj.type = 'media';
            }
            
            previousChatLog.messageTrack = 3;
            previousChatLog.finalResponse = message;
            previousChatLog.inviteStatus = 'Accepted';
            previousChatLog.updatedAt= Date.now();

            console.log('senderId', senderId)

            senderId.lastResponse = message;
            senderId.lastResponseUpdatedAt= Date.now();
            senderId.attendeesCount= senderId.invites === 'all'?'5': senderId.invites;
            senderId.inviteStatus = 'Accepted';

            // console.log('previousChatLog',previousChatLog);
            await senderId.save();
            await previousChatLog.save(); 
          const response = await sendMessageFunc({...sendMessageObj,message: reply }); 
          return res.send('thank you send')
          }
        }else{
          let reply = campaign?.thankYouText
          if(campaign?.thankYouMedia){              
            sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
            sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
            sendMessageObj.type = 'media';
          }
          previousChatLog.messageTrack = 3;
          previousChatLog.finalResponse = message;
          previousChatLog.inviteStatus = 'Accepted';
          previousChatLog.updatedAt= Date.now(),
          // console.log('previousChatLog',previousChatLog);
          await previousChatLog.save()
          const response = await sendMessageFunc({...sendMessageObj,message: reply }); 
          return res.send('thank you send')
        }
      }

      const rejectregex = new RegExp(`\\b${campaign.RejectionKeyword}\\b`, 'i');

      if(rejectregex.test(message.trim())){
        if( previousChatLog?.finalResponse){
          const reply =`Your data is already saved . Type *${campaign.RewriteKeyword}* to edit your choice`
          const response = await sendMessageFunc({...sendMessageObj,message: reply });
          return res.send('Type Change First')
        }

        previousChatLog['messageTrack']=3;
        previousChatLog['finalResponse']=message.toLowerCase();
        previousChatLog.inviteStatus = 'Rejected';
        previousChatLog.updatedAt= Date.now();

        if(true){
          senderId.lastResponse = message;
          senderId.lastResponseUpdatedAt= Date.now();
          senderId.inviteStatus ='Rejected';
          senderId.attendeesCount = '0'
          await senderId.save()
        }

        await previousChatLog.save()
        let reply = campaign?.messageForRejection
        const response = await sendMessageFunc({...sendMessageObj,message: reply }); 
        return res.send('rejection send')
      }

      if(campaign?.RewriteKeyword?.toLowerCase() === message?.toLowerCase()){
        if(!previousChatLog || previousChatLog.messageTrack===1){
          const response =  await sendMessageFunc({...sendMessageObj,message: 'Nothing to cancel' });
          return res.send(true);
        }
        previousChatLog['messageTrack']=1
        previousChatLog['finalResponse']=''
        await previousChatLog.save()
        let reply = campaign?.invitationText
          if(campaign?.invitationMedia){              
            sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
            sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
            sendMessageObj.type = 'media';
          }
        const response =  await sendMessageFunc({...sendMessageObj,message: reply });
        return res.send('after change message')
      }
      
      return res.send('nothing matched')
    }else if(["messages.update"].includes(req.body?.data?.event)){
      
      let data = messageObject.data.data
      for (const elem of data) {
        let messageId = elem.key?.id;
        let message = await Message.findOne({ messageId });
        if (!message) {
          continue;
        };
    
        let newStatus = {
          status: elem.update?.status,  // Replace with the actual status name
          time: new Date()            // Set the actual time or use a specific date
        };
    
        message.messageStatus.push(newStatus);
        await message.save();
        // console.log('message status Updated to '+ elem.update?.status+' for '+ message.text)
      }
      return res.send('status updated')
    }
    
    else{
      return res.send(false)
    }
  }catch (error){
    console.log(error)
    return res.status(500).json({ error: 'Internal server error' });
  }
}

const recieveMessagesV2 = async (req, res)=>{
  try{
    const messageObject = req.body;
    // console.log(req.body?.data?.event)
    // if(messageObject.data?.data?.messages?.[0]?.key?.fromMe === true) return res.send()
    if(["messages.upsert"].includes(req.body?.data?.event)){
      let message;
      message = messageObject.data.data.messages?.[0]?.message?.extendedTextMessage?.text || messageObject.data.data.messages?.[0]?.message?.conversation || '';
      let remoteId = messageObject.data.data.messages?.[0]?.key.remoteJid.split('@')[0];

      let fromMe = messageObject.data.data.messages?.[0]?.key?.fromMe
      let messageId = messageObject.data.data.messages?.[0]?.key?.id
      let timeStamp = messageObject.data.data.messages?.[0]?.messageTimestamp

      if(isNaN(remoteId.length)||remoteId.length>13){
        return res.send('invalid number')
      }

      const now = new Date();

      let start = new Date();
      start.setHours(0,0,0,0);

      let end = new Date();
      end.setHours(23,59,59,999);

      const recieverId = await Instance.findOne({instance_id: messageObject.instance_id})
      const senderId = await Contact.findOne({number: remoteId, eventId: recieverId?.eventId })

      // console.log(recieverId)
      if(!senderId) return res.send('No contacts in db');
      
      const currentTime = new Date();
      currentTime.setHours(currentTime.getHours() + 2);
      const updatedTimeISO = currentTime.toISOString();
      
      const previMessage = await Message.findOne({
        senderNumber: remoteId,
        recieverId : recieverId?._id,
        eventId: recieverId?.eventId,
        fromMe: false
      }).sort({createdAt: -1})

      const newMessage = {
        recieverId : recieverId?._id,
        senderNumber: remoteId,
        instanceId: messageObject?.instance_id,
        eventId: recieverId?.eventId,
        fromMe: fromMe,
        text: message,
        type: 'text',
        messageId,
        timeStamp: updatedTimeISO
      }

      const savedMessage = new Message(newMessage);
      await savedMessage.save();

      const sendMessageObj={
        number: remoteId,
        type: 'text',
        instance_id: messageObject?.instance_id,
      }

      const tempEvent = await Event.findOne({_id: senderId.eventId})

      if(message.toLowerCase()===tempEvent?.ReportKeyword && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');

        const fileName = await getReportdataByTime(start,end, recieverId?._id, tempEvent?._id ,rejectregex)
        // console.log('fileName', fileName)
        // const fileName = 'http://5.189.156.200:84/uploads/reports/Report-1716394369435.csv'
        sendMessageObj.filename = fileName.split('/').pop();
        sendMessageObj.media_url= process.env.IMAGE_URL+fileName;
        sendMessageObj.type = 'media';
        const response =  await sendMessageFunc({...sendMessageObj, message:'Download report'});
        return res.send(true);
      }

      if(message.toLowerCase()==='report dump' && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');

        const fileName = await getFullReport(start,end, recieverId?._id, tempEvent?._id ,rejectregex)
        // console.log('fileName', fileName)
        // const fileName = 'http://5.189.156.200:84/uploads/reports/Report-1716394369435.csv'
        sendMessageObj.filename = fileName.split('/').pop();
        sendMessageObj.media_url= process.env.IMAGE_URL+fileName;
        sendMessageObj.type = 'media';
        const response =  await sendMessageFunc({...sendMessageObj, message:'Download report dump'});
        return res.send(true);
      }
      
      if(message.toLowerCase()===tempEvent?.StatsKeyword && senderId?.isAdmin){
        if(!senderId?.isAdmin){
          const response =  await sendMessageFunc({...sendMessageObj, message: 'Invalid Input' });
          return res.send(true);
        }

        const replyObj = await getStats1(tempEvent?._id);

        let replyMessage = '*Statistics*';
        replyMessage += '\n';
        replyMessage += `\n› Total nos of Invitees: *${replyObj?.totalContacts}*`;
        replyMessage += `\n› Yes: *${replyObj?.totalYesContacts}*`;
        replyMessage += `\n› No: *${replyObj?.totalNoContacts}*`;
        replyMessage += `\n› Balance: *${replyObj?.totalLeft}*`;

        replyMessage += '\n\n*Day-wise Breakdown*\n';

        const sortedDays = Object.keys(replyObj?.dayStats || {}).sort((a, b) => {
          const dayA = parseInt(a.split('_')[1], 10);
          const dayB = parseInt(b.split('_')[1], 10);
          return dayA - dayB;
        });      

        sortedDays.forEach((day) => {
          const stats = replyObj.dayStats[day];
          replyMessage += `\n*${day.replace('_',' ')}*:\n`;
          replyMessage += `  - Yes: *${stats?.yes}*\n`;
          replyMessage += `  - No: *${stats?.no}*\n`;
          replyMessage += `  - Pending: *${stats?.pending}*\n`;
          replyMessage += `  - Total Accepted Invites: *${stats?.totalAccepted}*\n`;
        });
        
        const response = await sendMessageFunc({...sendMessageObj, message: replyMessage});
        return res.send(true);
      }

      if(message.toLowerCase() === `${tempEvent.initialCode}/${tempEvent?.newContactCode}` && senderId?.isAdmin){
        // console.log('message', message)
        let reply = 'Send new contact detail in following pattern.\nYou can copy the next message and send it again with your contact details';
        let Newreply = 'New_Contact\n'
        Newreply += '\nName: John Doe'
        Newreply += '\nInvites: 1/2/3/all'
        Newreply += '\nISD code: 91'
        Newreply += '\nNumber: 9999999999'
        Newreply += '\nParam1: '
        Newreply += '\nParam2: '
        Newreply += '\nParam3: '

        const response1 = await sendMessageFunc({...sendMessageObj,message: reply });
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response2 = await sendMessageFunc({...sendMessageObj,message: Newreply });

        return res.send('not a valid code')
      }
     
      if (previMessage && previMessage.text.toLowerCase() === `${tempEvent.initialCode}/${tempEvent?.newContactCode}` && senderId?.isAdmin && !newMessage.fromMe) {
        // console.log('new_contact', message.split('\n')[0].toLowerCase())
        if (message.split('\n')[0].toLowerCase() === 'new_contact') {
          const result = {};
          const lines = message.split('\n');
          // console.log('split', lines);
      
          lines.slice(2).forEach(item => {
            let [key, value] = item.split(':').map(part => part.trim());
            key = key.toLowerCase().replace(/ /g, ''); // Normalize key
      
            if (key === 'name') {
              result.name = value || null;
            } else if (key === 'invites') {
              result.invites = value || null;
            } else if (key === 'isdcode') {
              result.isdCode = value || '';
            } else if (key === 'number') {
              result.number = (result.isdCode ? result.isdCode : '') + (value || '');
            } else {
              result[key] = value || null;
            }
          });
      
          result['createdBy'] = senderId?._id;
          result['instanceId'] = recieverId?._id || null;
          result['eventId'] = recieverId?.eventId;
          result['inviteStatus'] = 'Pending';
      
          const { name, number } = result; // Extract name and number from result
      
          const existingContact = await Contact.findOne({
            eventId: recieverId?.eventId,
            $or: [
              { name },
              { number }
            ]
          });
      
          if (existingContact) {
            let errorMessage = 'Contact already exists with the same ';
            const errors = [];
            if (existingContact.name === name) errors.push('name');
            if (existingContact.number === number) errors.push('number');
      
            errorMessage += errors.join(' or ') + '.';
            const response = await sendMessageFunc({...sendMessageObj,message: errorMessage });
            return res.status(400).send({ error: errorMessage });
          }
      
          const contact = new Contact(result);
          await contact.save(); // Ensure the save operation is performed
          const response = await sendMessageFunc({...sendMessageObj,message: 'Contact saved' });
          return res.status(201).send('contact');
        }
      }

      const previousChatLog = await ChatLogs.findOne(
        {
          senderNumber: remoteId,
          instanceId: messageObject?.instance_id,
          eventId: senderId.eventId
        },
      ).sort({ updatedAt: -1 });
      if(fromMe) {
        const campaign = await Event.findOne({_id: recieverId?.eventId})
        const code = message.split('/') 
        if(code[0].toLowerCase() === campaign.initialCode.toLowerCase()){
          const codeType = code[1].toLowerCase()

          if(codeType === campaign.inviteCode){

            let reply = campaign?.invitationText
            if(campaign?.invitationMedia){              
              sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
              sendMessageObj.type = 'media';
            }
            senderId.hasCompletedForm = false;
            senderId.overAllStatus = 'Pending'
            senderId.lastResponse = '';
            senderId.updatedAt = Date.now();
            senderId.lastResponseUpdatedAt= Date.now();
            senderId.days = senderId.days.map((day) => {
              if (day.invitesAllocated && day.invitesAllocated !== '0') {
                day.inviteStatus = 'Pending'; // Reset to Pending
                day.invitesAccepted = '0'; // Reset to 0
              }
              return day;
            });

            await senderId.save()

            const response = await sendMessageFunc({...sendMessageObj,message: reply });
            const NewChatLog = await ChatLogs.findOneAndUpdate(
              {
                senderNumber: remoteId,
                instanceId: messageObject?.instance_id,
                eventId : campaign._id,
              },
              {
                $set: {
                  inviteStatus: 'Pending',
                  messageTrack: 1,
                  inviteIndex: 0,
                  isCompleted: false,
                  updatedAt: Date.now(),
                }
              },
              {
                upsert: true, // Create if not found, update if found
                new: true // Return the modified document rather than the original
              }
            )

            return res.send('invitemessageSend')

          } else if(codeType === campaign.acceptCode){

            const dayIndex = code[2]; // e.g., 1 (if exists)
            const inviteCount = code[3];

            let reply = campaign?.acceptanceAcknowledgment
            if(campaign?.thankYouMedia){              
              sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
              sendMessageObj.type = 'media';
            }

            senderId['overAllStatus'] = 'Accepted';
            if(dayIndex){
              const invitedDay = senderId.days[+dayIndex-1];
              const nextInvite = senderId.days.findIndex(
                (ele, index) => index > +dayIndex - 1 && ele.invitesAllocated && ele.inviteStatus === 'Pending'
              );
              if(inviteCount){
                senderId.days[+dayIndex-1].invitesAccepted = inviteCount
                senderId.days[+dayIndex-1].inviteStatus = 'Accepted'
                if(nextInvite !== -1){

                  previousChatLog['inviteIndex'] = nextInvite;
                  const inviteToSend = senderId.days[nextInvite];
                  const eventToInvite = campaign.subEventDetails[nextInvite]
        
                  reply = campaign.subEventInvitation
                }else{
                  console.log('else of nextInvite')
                  previousChatLog['inviteIndex'] = campaign.subEventDetails.length;
                  previousChatLog['isCompleted'] = true;
                  previousChatLog['messageTrack'] = 3;
                  
                  senderId['hasCompletedForm'] = true;

                  reply = campaign?.acceptanceAcknowledgment
                }

              }else{
                 if(invitedDay.invitesAllocated == 1){
                  senderId.days[+dayIndex-1].invitesAccepted = senderId.days[+dayIndex-1].invitesAllocated
                  senderId.days[+dayIndex-1].inviteStatus = 'Accepted'
                  
                  if(nextInvite){
                    previousChatLog['inviteIndex'] = nextInvite;
                   
                    reply = campaign?.subEventInvitation;
                  }else{
                    previousChatLog['inviteIndex'] = dayIndex;
                    previousChatLog['isCompleted'] = true;
                    previousChatLog['messageTrack'] = 3;
                    
                    senderId['hasCompletedForm'] = true;

                    reply = campaign?.acceptanceAcknowledgment
                  }

                 } else {
                  previousChatLog['inviteIndex'] = +dayIndex-1;
                  previousChatLog['messageTrack'] = 2;
                  senderId.days[+dayIndex-1].invitesAccepted = 0
                  senderId.days[+dayIndex-1].inviteStatus = 'Pending'
                  senderId['hasCompletedForm'] = true;
                  reply = campaign?.messageForMoreThanOneInvites;
                 }
              }

            }else{
              senderId.days = senderId.days.map((day) => {
                if (day.invitesAllocated && day.invitesAllocated !== '0') {
                  day.inviteStatus = 'Accepted';
                  if (day.invitesAllocated.toLowerCase() === 'all') {
                    day.invitesAccepted = '5';
                  } else {
                    day.invitesAccepted = day.invitesAllocated; 
                  }
                }
                return day;
              });
              
              senderId.overAllStatus = 'Accepted';
              senderId.hasCompletedForm = true;
            
              previousChatLog.messageTrack = 3;
              previousChatLog.inviteIndex = senderId.days.length;
              previousChatLog.isCompleted = true;
              previousChatLog.finalResponse = message;
              previousChatLog.inviteStatus = 'Accepted';
              previousChatLog.updatedAt = Date.now();
            }

             
            const inviteToSend = senderId.days[previousChatLog['inviteIndex']];
            const eventToInvite = campaign.subEventDetails[previousChatLog['inviteIndex']]
  
            reformData={
              ...inviteToSend?.toObject(),
              ...eventToInvite,
              ...senderId?.toObject(),
              }
  
            console.log(reformData)

            reply = replacePlaceholders(reply, reformData)
            const response = await sendMessageFunc({ ...sendMessageObj, message: reply });
              
            await previousChatLog.save()
            await senderId.save();
            return res.send('acceptMessageSent')

          } else if(codeType === campaign.rejectCode){
            previousChatLog['messageTrack']=3;
            previousChatLog['finalResponse']=message.toLowerCase();
            previousChatLog.updatedAt= Date.now();
            let reply = campaign?.messageForRejection

            if(true){
              if(senderId.inviteStatus==='Accepted' && code[2]<senderId.attendeesCount){
                senderId.lastResponse = message;
                senderId.lastResponseUpdatedAt= Date.now();
                senderId.attendeesCount = (+senderId.attendeesCount)-(+code[2])
                await senderId.save()
                reply = campaign?.thankYouText
                  if(campaign?.thankYouMedia){              
                    sendMessageObj.filename = campaign?.thankYouMedia.split('/').pop();
                    sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.thankYouMedia;
                    sendMessageObj.type = 'media';
                  }

              }else{
                senderId.lastResponse = message;
                senderId.lastResponseUpdatedAt= Date.now();
                senderId.inviteStatus ='Rejected';
                senderId.attendeesCount = '0'
                await senderId.save()
                previousChatLog.inviteStatus = 'Rejected';
              }
            }

            await previousChatLog.save()
            const response = await sendMessageFunc({...sendMessageObj,message: reply }); 

            return res.send('rejectmessageSend')

          }
        }
        return res.send('nothing')
      }

      let reply;

      if(!previousChatLog){
        const campaignData = await Event.find({_id: recieverId.eventId})
        console.log({campaignData})
        for (let campaign of campaignData){
          let contact;
          if(true){
            contact = await Contact.findOne({number: remoteId, eventId: campaign?._id.toString()})
            // console.log({contact})
            if(!contact) {
              // reply = campaign.numberVerificationFails;
              // const response = await sendMessageFunc({...sendMessageObj,message: reply });
              return res.send('Account not found')
            }
          }
          if(campaign.startingKeyword.toLowerCase() === message.toLowerCase()){
            const currentTime = moment();
           
            const startingTime = moment(campaign.startDate)
            .set('hour', campaign.startHour)
            .set('minute', campaign.startMinute);
      
          const endingTime = moment(campaign.endDate)
            .set('hour', campaign.endHour)
            .set('minute', campaign.endMinute);

            if (!currentTime.isBetween(startingTime, endingTime)) {
              const response =  await sendMessageFunc({...sendMessageObj,message: campaign?.messageForClosedInvitations });
              return res.send(true);      
            }
            let reply = campaign?.invitationText
            if(campaign?.invitationMedia){              
              sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
              sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
              sendMessageObj.type = 'media';
            }
            const response = await sendMessageFunc({...sendMessageObj,message: reply });
            const NewChatLog = await ChatLogs.findOneAndUpdate(
              {
                senderNumber: remoteId,
                instanceId: messageObject?.instance_id,
                updatedAt: { $gte: start, $lt: end },
                eventId : campaign._id,
                messageTrack:  1
              },
              {
                $set: {
                  updatedAt: Date.now(),
                  isValid: contact? true: false
                }
              },
              {
                upsert: true, // Create if not found, update if found
                new: true // Return the modified document rather than the original
              }
            )
            return res.send('firstMessage sent')
          }
        }
        return res.send('No active campaign found')
       
      }

      const campaign = await Event.findOne({_id: previousChatLog?.eventId})

      if(campaign?.RewriteKeyword?.toLowerCase() === message?.toLowerCase()){
        if(!previousChatLog || previousChatLog.messageTrack===1){
          const response =  await sendMessageFunc({...sendMessageObj,message: 'Nothing to cancel' });
          return res.send(true);
        }
        previousChatLog['messageTrack']=1
        previousChatLog['finalResponse']=''
        previousChatLog['inviteStatus']='Pending'
        await previousChatLog.save()
        if(true){
          senderId.lastResponse = '';
          senderId.lastResponseUpdatedAt= Date.now();
          senderId.inviteStatus ='Pending';
          senderId.attendeesCount='0'
          senderId.save();
        }
        let reply = campaign?.invitationText
          if(campaign?.invitationMedia){              
            sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
            sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
            sendMessageObj.type = 'media';
          }
        const response =  await sendMessageFunc({...sendMessageObj,message: reply });
        return res.send('after change message')
      }

      if(previousChatLog['messageTrack']>0){
        const contact =  await Contact.findOne({number: remoteId, eventId: campaign?._id.toString()})
        // if(contact.hasCompletedForm){
        //   const updatedAtTime = new Date(previousChatLog.updatedAt).getTime(); // convert updatedAt to milliseconds
        //   const currentTime = now.getTime(); // current time in milliseconds
        //   if (currentTime - updatedAtTime <= 3600000) {
        //     console.log("Within 1 hour of session");
        //   } else {
        //     return res.send('');
        //   }
        // }
        
        const acceptregex = new RegExp(`\\b${campaign.acceptanceKeyword}\\b`, 'i');
        const rejectregex = new RegExp(`\\b${tempEvent.RejectionKeyword}\\b`, 'i');
        
        if(previousChatLog['messageTrack'] === 1 && acceptregex.test(message.trim())){
          console.log('step 1')
            const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.inviteStatus === 'Pending');
            const inviteToSend = index !== -1 ? contact.days[index] : null;
            const eventToInvite = campaign.subEventDetails[index]
  
            reformData={
              ...inviteToSend?.toObject(),
              ...eventToInvite,
              ...contact?.toObject(),
              }
  
            console.log(reformData)
            const reply = replacePlaceholders(campaign.subEventInvitation, reformData)
            const response = await sendMessageFunc({...sendMessageObj,message: reply });
            previousChatLog['messageTrack'] ++;
            previousChatLog['inviteStatus'] = 'Accepted';
            previousChatLog['inviteIndex'] = index;
  
            contact['overAllStatus'] = 'Accepted';
  
            await contact.save();
            await previousChatLog.save();
            return res.send('Type Change First')

        }else if(previousChatLog['messageTrack'] === 1 && rejectregex.test(message.trim())){
          console.log('step 2')
          const reply = replacePlaceholders(campaign.rejectionAcknowledgment, reformData)
          const response = await sendMessageFunc({...sendMessageObj,message: reply });
          previousChatLog['messageTrack']  ++;
          previousChatLog['inviteStatus'] = 'Rejected';
          previousChatLog['isCompleted'] = true;

          contact['hasCompletedForm'] = true;
          contact['overAllStatus'] = 'Rejected';

          await previousChatLog.save();
          await contact.save();
          return res.send('Type Change First')

        }else {
          console.log('step 3')
          if(campaign.hasSubEvent && previousChatLog['inviteIndex'] < campaign.subEventDetails.length){
            console.log('step 4')
            const dayInvite = contact.days[previousChatLog['inviteIndex']]

            if(acceptregex.test(message.trim())){
              console.log('step 5')
              if(dayInvite.invitesAllocated == 1){
                console.log('step 6')
                contact.days[previousChatLog['inviteIndex']].invitesAccepted = dayInvite.invitesAllocated;
                contact.days[previousChatLog['inviteIndex']].inviteStatus = 'Accepted';

                const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.inviteStatus === 'Pending');
                const inviteToSend = index !== -1 ? contact.days[index] : null;
                const eventToInvite = campaign.subEventDetails[index]
      
                reformData={
                  ...inviteToSend?.toObject(),
                  ...eventToInvite,
                  ...contact?.toObject()
                  }
    
                  let reply
                  if(index != -1){
                    previousChatLog['inviteIndex'] = index;
                    reply = replacePlaceholders(campaign.subEventInvitation, reformData)
                  }else{
                    previousChatLog['inviteIndex'] ++;
                    previousChatLog['isCompleted'] = true;
                    contact['hasCompletedForm'] = true;
                    previousChatLog['messageTrack'] ++;
                    reply = replacePlaceholders(campaign.acceptanceAcknowledgment, reformData)
                  }
                  const response = await sendMessageFunc({...sendMessageObj,message: reply });
                  await previousChatLog.save();
                  await contact.save();
                  return res.send('sending invite message')
              }else{
                console.log('step 7')
                reformData={
                  ...dayInvite?.toObject(),
                  ...contact.days[previousChatLog['inviteIndex']]?.toObject(),
                  ...contact?.toObject()
                  }
                const reply = replacePlaceholders(campaign?.messageForMoreThanOneInvites, reformData)
                const response = await sendMessageFunc({...sendMessageObj,message: reply });
                return res.send('More Invites')
              }   
            }

            const numbersString = extractNumberOrAll(message.toLowerCase());
              function extractNumberOrAll(input) {
              const numberMatch = input.match(/\d+/);
              if (numberMatch) {
                return numberMatch[0];
              } else if (/\ball\b/i.test(input)) {
                return "all";
              } else {
                return null; // or any default value you want to return if neither is found
              }
            }
            if(numbersString !== null && (numbersString == dayInvite.invitesAllocated.toLowerCase() || (dayInvite.invitesAllocated.toLowerCase() === "all" || (!isNaN(numbersString) && +numbersString <= dayInvite.invitesAllocated)))){
              console.log('step 8')
              contact.days[previousChatLog['inviteIndex']].invitesAccepted = numbersString;
              contact.days[previousChatLog['inviteIndex']].inviteStatus = 'Accepted';
  
              const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.inviteStatus === 'Pending');
              const inviteToSend = index !== -1 ? contact.days[index] : null;
              const eventToInvite = campaign.subEventDetails[index]
    
              reformData={
                ...inviteToSend?.toObject(),
                ...eventToInvite,
                ...contact?.toObject()
                }
  
                let reply
                if(index != -1){
                  previousChatLog['inviteIndex'] = index;
                  reply = replacePlaceholders(campaign.subEventInvitation, reformData)
                }else{
                  previousChatLog['inviteIndex'] ++;
                  previousChatLog['isCompleted'] = true;
                  previousChatLog['messageTrack'] ++;
                  previousChatLog['inviteStatus'] = 'Accepted';
                  contact['hasCompletedForm'] = true;
                  reply = replacePlaceholders(campaign.acceptanceAcknowledgment, reformData)
                }
                const response = await sendMessageFunc({...sendMessageObj,message: reply });

                await previousChatLog.save();
                await contact.save();
                return res.send('sending invite message')
            }else if(rejectregex.test(message.trim())){
              console.log('step 9')
              contact.days[previousChatLog['inviteIndex']].invitesAccepted = message;
              contact.days[previousChatLog['inviteIndex']].inviteStatus = 'Rejected';
              const index = contact.days.findIndex(ele => ele.invitesAllocated && ele.inviteStatus === 'Pending');
              if(index==-1){
                let reply = campaign?.acceptanceAcknowledgment
                const response = await sendMessageFunc({...sendMessageObj,message: reply }); 
                return res.send('rejection send')
              }
              const inviteToSend = index !== -1 ? contact.days[index] : null;
              const eventToInvite = campaign.subEventDetails[index]
    
              console.log('eventToInvite', eventToInvite);
    
              reformData={
                ...inviteToSend?.toObject(),
                ...eventToInvite,
                ...contact?.toObject()
                }
    
                let reply
                if(index != -1){
                  previousChatLog['inviteIndex'] = index;
                  reply = replacePlaceholders(campaign.subEventInvitation, reformData)
                }else{
                  previousChatLog['inviteIndex'] ++;
                  previousChatLog['isCompleted'] = true;
                  previousChatLog['messageTrack'] ++;
                  contact['hasCompletedForm'] = true;
                  reply = replacePlaceholders(campaign.acceptanceAcknowledgment, reformData)
                }
                const response = await sendMessageFunc({...sendMessageObj,message: reply });
              await previousChatLog.save();
              await contact.save();
              return res.send('sending invite message')
            }else{

            }
          }else{

          }
        } 
        // console.log('contact', contact);
        // console.log('campaign', campaign);
        // console.log('previousChatLog', previousChatLog);
        
      }

      if(campaign?.RewriteKeyword?.toLowerCase() === message?.toLowerCase()){
        if(!previousChatLog || previousChatLog.messageTrack===1){
          const response =  await sendMessageFunc({...sendMessageObj,message: 'Nothing to cancel' });
          return res.send(true);
        }
        previousChatLog['messageTrack']=1
        previousChatLog['finalResponse']=''
        await previousChatLog.save()
        let reply = campaign?.invitationText
          if(campaign?.invitationMedia){              
            sendMessageObj.filename = campaign?.invitationMedia.split('/').pop();
            sendMessageObj.media_url= process.env.IMAGE_URL+campaign?.invitationMedia;
            sendMessageObj.type = 'media';
          }
        const response =  await sendMessageFunc({...sendMessageObj,message: reply });
        return res.send('after change message')
      }
      
      return res.send('nothing matched')
    }else if(["messages.update"].includes(req.body?.data?.event)){
      
      let data = messageObject.data.data
      for (const elem of data) {
        let messageId = elem.key?.id;
        let message = await Message.findOne({ messageId });
        if (!message) {
          continue;
        };
    
        let newStatus = {
          status: elem.update?.status,  // Replace with the actual status name
          time: new Date()            // Set the actual time or use a specific date
        };
    
        message.messageStatus.push(newStatus);
        await message.save();
        // console.log('message status Updated to '+ elem.update?.status+' for '+ message.text)
      }
      return res.send('status updated')
    }
    
    else{
      return res.send(false)
    }
  }catch (error){
    console.log(error)
    return res.status(500).json({ error: 'Internal server error' });
  }
}


const sendMessageFunc = async (message, data={})=>{
  console.log(message)
  const instance = await Instance.findOne({
    instance_id: message.instance_id
  }).sort({ updatedAt: -1 })

  const contact = await Contact.findOne({number: message.number, eventId: instance?.eventId.toString()});
  message.message = reformText(message?.message, {contact})
  
  const url = process.env.LOGIN_CB_API
  const access_token = process.env.ACCESS_TOKEN_CB
  if(message?.media_url){
    const newMessage = {
      ...message,
      senderNumber: message?.number,
      instanceId: message?.instance_id,
      fromMe: true,
      text: message?.message,
      media_url: message?.media_url,
      eventId: instance?.eventId
    }
    const savedMessage = new Message(newMessage);
    await savedMessage.save();
  }

  // console.log('aaaa',newMessage)

  const response = await axios.get(`${url}/send`,{params:{...message,access_token}})
  // console.log(response)
  return true;
}

const reformText = (message, data)=>{
  const {contact, chatLog} = data;
  
  let mergedContact = {};
  
  if(contact){
    mergedContact = {...contact?.toObject()};
  }

  if(chatLog?.otherMessages){
    Object.entries(chatLog?.otherMessages).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        if (value?.name !== undefined) {
          mergedContact[key] = value.name;
        } else if (value.value !== undefined) {
          mergedContact[key] = value.value;
        }
      }
    });
  }

  return replacePlaceholders(message, mergedContact);  
}

function replacePlaceholders(message, data) {
  return message.replace(/{(\w+)}/g, (_, key) => data[key] || `{${key}}`);
}



const getReport = async (req, res) => {
  const { fromDate, toDate } = req.query;
  let startDate, endDate;

  if (fromDate && toDate) {
    startDate = new Date(fromDate);
    endDate = new Date(toDate);
  }

  let dateFilter = {};
  if (startDate && endDate) { // If both startDate and endDate are defined, add a date range filter
    dateFilter = {
      "updatedAt": {
        $gte: startDate,
        $lt: endDate
      }
    };
  }

  let query = [
    {
      $lookup: {
        from: 'chatlogs',
        let: { contactITS: '$ITS' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$requestedITS', '$$contactITS'] },
                  { $eq: ['$instance_id', req.params.id] },
                  { $gte: ['$updatedAt', startDate] },
                  { $lt: ['$updatedAt', endDate] }
                ]
              }
            }
          }
        ],
        as: 'chatlog'
      }
    },
    { $unwind: { path: '$chatlog', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        PhoneNumber: { $toString: '$number' }  // Assuming `number` is directly in contacts
      }
    },
    {
      $project: {
        _id: 0,
        ITS: '$ITS',
        Name: '$name',
        PhoneNumber: 1,
        updatedAt: '$chatlog.updatedAt',
        Status: '$chatlog.messageTrack',
        Venue: '$chatlog.otherMessages.venue',
        Response: '$chatlog.otherMessages.profile'
      }
    }
  ];

  try {

const formatDate = (date) => {
      if (!date || isNaN(new Date(date).getTime())) {
        return ''; // Return blank if date is invalid
      }
      const options = { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit', 
        hour12: true 
      };
      return new Date(date).toLocaleString('en-US', options).replace(',', '');
    };

    let data = await Contact.aggregate(query);
    data = data.map(ele=>({
      ...ele,
      'updatedAt': formatDate(ele.updatedAt),
      Venue: getNames('venue', ele?.Venue),
      Response: getNames('profile', ele?.Response),
    }))

    const fileName = `Report-${Date.now()}.csv`
    const filePath = `uploads/reports/${fileName}`;
    const csvWriter = createCsvWriter({
      path: filePath,
      header: [
        { id: 'Name', title: 'Name' },
        { id: 'PhoneNumber', title: 'PhoneNumber' },
        { id: 'ITS', title: 'ITS' },
        { id: 'updatedAt', title: 'Updated At' },
        { id: 'Venue', title: 'Venue' },
        { id: 'Response', title: 'Response' },
        { id: 'Status', title: 'Status' },
      ]
    });

    await csvWriter.writeRecords(data);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (error) {
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
};


async function getReportdataByTime(startDate, endDate, id, eventId, rejectregex) {
  let dateFilter = {};
  if (startDate && endDate) {
    dateFilter = {
      "updatedAt": {
        $gte: new Date(startDate),
        $lt: new Date(endDate)
      }
    };
  }

  // console.log('instance', id)
  let query = [
    {
      $match: { eventId: eventId.toString(), }
    },
    {
      $lookup: {
        from: 'chatlogs',
        let: { contactNumber: '$number', eventId: '$eventId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$senderNumber', '$$contactNumber'] },
                  { $eq: ['$eventId', '$$eventId'] }
                ]
              }
            }
          },
          { $sort: { createdAt: -1 } }, // Sort by date in descending order
          { $limit: 1 } // Take only the latest chatlog
        ],
        as: 'chatlog'
      }
    },
    { $unwind: { path: '$chatlog', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        finalResponse: { $ifNull: ['$chatlog.finalResponse', ''] },
      }
    },
    {
      $project: {
        _id: 0,
        Name: '$name',
        PhoneNumber: { $toString: '$number' },
        days: '$days',
        overAllStatus: '$overAllStatus',
        UpdatedAt: { $ifNull: [{ $dateToString: { format: '%Y-%m-%d %H:%M:%S', date: '$updatedAt' } }, ''] }
      }
    }
  ];

  try {
    const formatDate = (date) => {
      if (!date || isNaN(new Date(date).getTime())) {
        return ''; // Return blank if date is invalid
      }
      const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      };
      return new Date(date).toLocaleString('en-US', options).replace(',', '');
    };

    let data = await Contact.aggregate(query);

    console.log('data', data)

    data = data.map(ele => {
      let dayInfo = ele.days.map((day, index) => {
        if (day.invitesAllocated === 0) {
          return `Day${index + 1}: not invited`;
        } else {
          return `Day${index + 1}: ${day.invitesAllocated}/${day.invitesAccepted}`;
        }
      });

      return {
        Name: ele.Name,
        'Phone Number': ele.PhoneNumber,
        ...dayInfo.reduce((acc, val, idx) => ({ ...acc, [`Day${idx + 1}`]: val }), {}),
        Status: ele.overAllStatus,
        'Updated At': formatDate(ele.UpdatedAt)
      };
    });

    console.log('data----', data)

    const fileName = `Report-${Date.now()}.xlsx`;
    const filePath = `uploads/reports/${fileName}`;
    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Report');
    xlsx.writeFile(wb, filePath);

    console.log(`XLSX file created successfully at ${filePath}`);

    return filePath;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function getFullReport(startDate, endDate, id, eventId, rejectregex) {
  let dateFilter = {};
  if (startDate && endDate) {
    dateFilter = {
      "updatedAt": {
        $gte: new Date(startDate),
        $lt: new Date(endDate)
      }
    };
  }

  // console.log('instance', id)
  let query = [
    {
      $match: { eventId: eventId.toString(), }
    },
    {
      $lookup: {
        from: 'chatlogs',
        let: { contactNumber: '$number', eventId: '$eventId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$senderNumber', '$$contactNumber'] },
                  { $eq: ['$eventId', '$$eventId'] }
                ]
              }
            }
          },
        ],
        as: 'chatlog'
      }
    },
    { $unwind: { path: '$chatlog', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        finalResponse: { $ifNull: ['$chatlog.finalResponse', ''] },
      }
    },
    {
      $project: {
        _id: 0,
        Name: '$name',
        PhoneNumber: { $toString: '$number' },
        invites: '$invites',
        'UpdatedAt': { $ifNull: [{ $dateToString: { format: '%Y-%m-%d %H:%M:%S', date: '$updatedAt' } }, ''] },

        Status: '$inviteStatus',
        finalResponse: 1,
        attendeesCount: 1
      }
    }
  ];

  try {
    const formatDate = (date) => {
      if (!date || isNaN(new Date(date).getTime())) {
        return ''; // Return blank if date is invalid
      }
      const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      };
      return new Date(date).toLocaleString('en-US', options).replace(',', '');
    };

    let data = await Contact.aggregate(query);

    // console.log(data)

    data = data.map(ele => ({
      Name: ele.Name,
      'Phone Number': ele.PhoneNumber,
      Invites: ele.invites,
      'Updated At': formatDate(ele['UpdatedAt']),
      Status: ele.Status,
      'Last Response': ele.finalResponse,
      'Guest Count': ele.attendeesCount
    }));

    const fileName = `Report-${Date.now()}.xlsx`;
    const filePath = `uploads/reports/${fileName}`;
    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Report');
    xlsx.writeFile(wb, filePath);

    console.log(`XLSX file created successfully at ${filePath}`);

    return filePath;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function getStats2(eventId, startDate, endDate) {
  if (startDate && endDate) {
    dateFilter = {
      createdAt: {
        $gte: new Date(startDate),
        $lt: new Date(endDate)
      }
    };
  }

  try {
    const [stats, totalContacts, totalGuests] = await Promise.all([
      Contact.aggregate([
        {
          $match: {
            eventId: eventId.toString()
          }
        },
        {
          $facet: {
            totalEntries: [{ $count: "count" }],
            totalYesResponses: [
              { $match: { inviteStatus: 'Accepted' } },
              { $count: "count" }
            ],
            totalNoResponses: [
              { $match: { inviteStatus: 'Rejected' } },
              { $count: "count" }
            ],
            totalPendingResponses: [
              { $match: { inviteStatus: 'Pending' } },
              { $count: "count" }
            ]
          }
        }
      ]).then(result => result[0]),

      Contact.aggregate([
        {
          $match: {
            eventId: eventId.toString(),
          }
        },
        {
          $count: 'totalContacts'
        }
      ]).then(result => (result[0] ? result[0].totalContacts : 0)),

      Contact.aggregate([
        {
          $match: {
            eventId: eventId.toString(),
          }
        },
        {
          $group: {
            _id: null,
            totalGuests: { $sum: { $toInt: "$attendeesCount" } }
          }
        }
      ]).then(result => (result[0] ? result[0].totalGuests : 0))
    
    ]);

    console.log('stats', stats, totalContacts, totalGuests)
    const totalYesResponses = stats.totalYesResponses[0] ? stats.totalYesResponses[0].count : 0;
    const totalNoResponses = stats.totalNoResponses[0] ? stats.totalNoResponses[0].count : 0;
    const totalPendingResponses = stats.totalPendingResponses[0] ? stats.totalPendingResponses[0].count : 0;

    return {
      totalContacts,
      yes: totalYesResponses,
      guestCount: totalGuests,
      no: totalNoResponses,
      balance: totalPendingResponses
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    throw error; // Ensure errors are thrown to be handled by the calling function
  }
}

async function getStats(eventId) {
  try {
    // Step 1: Fetch all contacts related to the event
    const contacts = await Contact.find({ eventId: eventId.toString() });
    
    // Initialize variables
    let totalContacts = contacts.length;
    let totalYesContacts = 0;
    let totalNoContacts = 0;
    let totalLeft = 0;
    const dayStats = {};

    contacts.forEach(contact => {
      // Step 2: Count overall status (Yes, No, Left)
      if (contact.overAllStatus === 'Accepted' ) {
        totalYesContacts++;
      } else if (contact.overAllStatus === 'Rejected') {
        totalNoContacts++;
      } else {
        totalLeft++;
      }

      // Step 3: Loop through each day in the contact's `days` array
      contact.days.forEach((day, index) => {
        // Initialize the day if not already done
        if (!dayStats[`Day_${index + 1}`]) {
          dayStats[`Day_${index + 1}`] = {
            yes: 0,
            no: 0,
            pending: 0,
            totalAccepted: 0
          };
        }

        // Increment values based on the day's status
        if (day.inviteStatus === 'Accepted') {
          dayStats[`Day_${index + 1}`].yes++;
        } else if (day.inviteStatus === 'Rejected') {
          dayStats[`Day_${index + 1}`].no++;
        } else if (day.inviteStatus === 'Pending') {
          dayStats[`Day_${index + 1}`].pending++;
        }

        // Sum invites allocated and accepted for the day
        dayStats[`Day_${index + 1}`].totalAccepted += parseInt(day.invitesAccepted, 10);
      });
    });

    // Step 4: Return the aggregated statistics
    return {
      totalContacts,
      totalYesContacts,
      totalNoContacts,
      dayStats,
      totalLeft
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    throw error; // Ensure errors are thrown to be handled by the calling function
  }
}

async function getStats1(eventId) {
  try {
    // Step 1: Use MongoDB's aggregation framework to compute the statistics directly in the database
    const result = await Contact.aggregate([
      { $match: { eventId: eventId.toString() } }, // Match the contacts for the specific eventId

      // Step 2: Unwind the days array to compute stats for each day individually
      { $unwind: "$days" },

      // Step 3: Add a sequential index field to represent the day index
      {
        $group: {
          _id: {
            eventId: "$eventId",
            contactId: "$_id",
          },
          days: { $push: "$days" },
          overAllStatus: { $first: "$overAllStatus" }
        }
      },
      {
        $addFields: {
          dayIndexes: { $range: [0, { $size: "$days" }] }
        }
      },
      { $unwind: { path: "$days", includeArrayIndex: "dayIndex" } },

      // Step 4: Group by eventId and dayIndex to aggregate the stats
      {
        $group: {
          _id: {
            eventId: "$_id.eventId",
            dayIndex: "$dayIndex",
          },
          yesCount: {
            $sum: {
              $cond: [{ $eq: ["$days.inviteStatus", "Accepted"] }, 1, 0],
            },
          },
          noCount: {
            $sum: {
              $cond: [{ $eq: ["$days.inviteStatus", "Rejected"] }, 1, 0],
            },
          },
          pendingCount: {
            $sum: {
              $cond: [{ $eq: ["$days.inviteStatus", "Pending"] }, 1, 0],
            },
          },
          totalAccepted: { $sum: "$days.invitesAccepted" },
        },
      },

      // Step 5: Group the results by eventId to combine all day indices into one result
      {
        $group: {
          _id: "$_id.eventId",
          dayStats: {
            $push: {
              dayIndex: "$_id.dayIndex",
              yes: "$yesCount",
              no: "$noCount",
              pending: "$pendingCount",
              totalAccepted: "$totalAccepted",
            },
          },
        },
      },

      // Step 6: Merge the overall statistics
      {
        $lookup: {
          from: "contacts",
          localField: "_id",
          foreignField: "eventId",
          as: "contacts",
        },
      },
      {
        $addFields: {
          totalContacts: { $size: "$contacts" },
          totalYesContacts: {
            $size: {
              $filter: {
                input: "$contacts",
                as: "contact",
                cond: { $eq: ["$$contact.overAllStatus", "Accepted"] },
              },
            },
          },
          totalNoContacts: {
            $size: {
              $filter: {
                input: "$contacts",
                as: "contact",
                cond: { $eq: ["$$contact.overAllStatus", "Rejected"] },
              },
            },
          },
          totalLeft: {
            $size: {
              $filter: {
                input: "$contacts",
                as: "contact",
                cond: {
                  $and: [
                    { $ne: ["$$contact.overAllStatus", "Accepted"] },
                    { $ne: ["$$contact.overAllStatus", "Rejected"] },
                  ],
                },
              },
            },
          },
        },
      },

      // Step 7: Project the final output to match the desired format
      {
        $project: {
          _id: 0,
          totalContacts: 1,
          totalYesContacts: 1,
          totalNoContacts: 1,
          totalLeft: 1,
          dayStats: {
            $arrayToObject: {
              $map: {
                input: "$dayStats",
                as: "day",
                in: {
                  k: { $concat: ["Day_", { $toString: { $add: ["$$day.dayIndex", 1] } }] },
                  v: {
                    yes: "$$day.yes",
                    no: "$$day.no",
                    pending: "$$day.pending",
                    totalAccepted: "$$day.totalAccepted",
                  },
                },
              },
            },
          },
        },
      },
    ]);

    // If result is empty, return default values
    if (!result.length) {
      return {
        totalContacts: 0,
        totalYesContacts: 0,
        totalNoContacts: 0,
        totalLeft: 0,
        dayStats: {},
      };
    }

    // Return the computed statistics
    return result[0];
  } catch (error) {
    console.error("Error getting stats:", error);
    throw error; // Ensure errors are thrown to be handled by the calling function
  }
}

const fetchDashBoardStats = async(req, res)=>{
  const {eventId, instance_id} = req.body
  const instance = await Instance.findOne({_id:instance_id})
  const statsBody = await getStats1(eventId, instance, '','')
  return res.send(statsBody)
}


module.exports = {
  saveContact,
  getContact,
  updateContacts,
  getMessages,
  sendMessages,
  recieveMessagesV2,
  getReport,
  saveContactsInBulk,
  sendBulkMessage,
  fetchDashBoardStats
};
